import "dotenv/config";
import { Contract, JsonRpcProvider, NonceManager, parseUnits, Wallet } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  REFERRAL_TARGET_TOKEN_ADDRESS=0x... npm run referral-plan-test

Useful env:
  GROWCHAIN_API_BASE_URL             default https://api.growchain.vip/testnet
  REFERRAL_TARGET_TOKEN_ADDRESS      token to buy/sell
  REFERRAL_REUSE_REPORT_PATH         reuse wallet role mapping from a previous report json
  REFERRAL_REPORT_BASE               output base path without extension
`);
  process.exit(0);
}

type GeneratedWallet = {
  index: number;
  address: string;
  privateKey: string;
};

type ReferralNode = {
  label: string;
  parentLabel: string;
  wallet: GeneratedWallet;
  token?: string;
  invitationCode?: string;
  boundReferrer?: string | null;
  bindStatus?: string;
  bindError?: string;
  buyHash?: string;
  buyStatus?: string;
  buyError?: string;
  boughtTokenAmount?: string;
  sellHash?: string;
  sellStatus?: string;
  sellError?: string;
  sellTokenAmount?: string;
  lifetimeTotal?: string;
  lifetimeTrade?: string;
  lifetimeReferral?: string;
  lifetimeMarket?: string;
  todayTotal?: string;
  hashpower?: string;
  subtreePoints?: string;
  largestBranchPoints?: string;
  networkTotal?: string;
  hashpowerShare?: string;
  directCount?: number;
  totalSubtreeCount?: number;
  updatedAt?: string;
};

const apiBaseUrl = process.env.GROWCHAIN_API_BASE_URL || "https://api.growchain.vip/testnet";
const rpcUrl = requiredEnv("RPC_URL");
const walletsPath = process.env.GENERATED_WALLETS_PATH || "wallets/generated-wallets.json";
const marketContractAddress = process.env.REFERRAL_MARKET_CONTRACT || requiredEnv("BUY_CONTRACT_ADDRESS");
const usdtAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const targetTokenAddress =
  process.env.REFERRAL_TARGET_TOKEN_ADDRESS || "0x3226973bfee38d8d28e49bc0866db0b7bbc27910";
const buyUsdtAmount = process.env.REFERRAL_BUY_USDT || "10000";
const sellUsdtHint = process.env.REFERRAL_SELL_USDT_HINT || "5000";
const planMode = process.env.REFERRAL_PLAN_MODE || "classic-73";
const executionMode = process.env.REFERRAL_EXECUTION_MODE || "buy-sell";
const nodeBuyUsdtConfig = parseNodeBuyConfig(process.env.REFERRAL_NODE_BUY_USDT_JSON);
const walletStartIndex = numberEnv("REFERRAL_WALLET_START_INDEX", 0);
const rpcBatchMaxCount = numberEnvAllowZero("REFERRAL_RPC_BATCH_MAX_COUNT", 1);
const maxConcurrency = numberEnv("REFERRAL_MAX_CONCURRENCY", 5);
const pointsPollRounds = numberEnv("REFERRAL_POINTS_POLL_ROUNDS", 10);
const pointsPollIntervalMs = numberEnv("REFERRAL_POINTS_POLL_INTERVAL_MS", 60_000);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const reportBase = process.env.REFERRAL_REPORT_BASE || `reports/referral-plan-${runId}`;

const provider = new JsonRpcProvider(rpcUrl, undefined, {
  staticNetwork: true,
  batchMaxCount: rpcBatchMaxCount
});
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const usdt = new Contract(usdtAddress, erc20Abi, provider);
const targetToken = new Contract(targetTokenAddress, erc20Abi, provider);
const [usdtDecimals, targetDecimals, targetSymbol] = await Promise.all([
  usdt.decimals(),
  targetToken.decimals(),
  targetToken.symbol().catch(() => "TOKEN")
]);

const wallets = JSON.parse(readFileSync(walletsPath, "utf8")) as GeneratedWallet[];
const requiredWalletCount = planMode === "first13-mini" ? 13 : planMode === "first14-c4-heavy" ? 14 : 73;
if (wallets.length < requiredWalletCount) {
  throw new Error(`Need at least ${requiredWalletCount} wallets, found ${wallets.length}.`);
}

const nodes = process.env.REFERRAL_REUSE_REPORT_PATH
  ? buildReferralNodesFromReport(process.env.REFERRAL_REUSE_REPORT_PATH, wallets)
  : buildPlanNodes(wallets);

console.log(`API: ${apiBaseUrl}`);
console.log(`Market: ${marketContractAddress}`);
console.log(`USDT: ${usdtAddress}`);
console.log(`Target: ${targetTokenAddress} (${targetSymbol}, decimals ${Number(targetDecimals)})`);
console.log(`Wallets selected: ${nodes.length}`);
console.log(`Plan mode: ${planMode}`);
console.log(`Execution mode: ${executionMode}`);
if (process.env.REFERRAL_REUSE_REPORT_PATH) {
  console.log(`Reused wallet role mapping: ${process.env.REFERRAL_REUSE_REPORT_PATH}`);
}
console.log(`Buy amount: ${buyUsdtAmount} USDT`);
if (Object.keys(nodeBuyUsdtConfig).length > 0) {
  console.log(`Node buy overrides: ${JSON.stringify(nodeBuyUsdtConfig)}`);
}
console.log(`Sell amount: about ${sellUsdtHint} USDT, implemented as half of tokens bought`);
console.log(`Report base: ${reportBase}`);

writeReports(nodes);

console.log("Logging in selected wallets and loading referral state...");
await runWithConcurrency(
  nodes.map((node) => async () => {
    node.token = await login(new Wallet(node.wallet.privateKey));
    await refreshNode(node);
    await loadInvitationCode(node);
    writeReports(nodes);
  }),
  maxConcurrency
);

console.log("Binding referral tree...");
for (const node of nodes) {
  if (!node.parentLabel) continue;
  await bindNode(node);
  await refreshNode(node);
  writeReports(nodes);
}

console.log(
  executionMode === "buy-only"
    ? `Executing one ${buyUsdtAmount}U buy for every selected wallet...`
    : `Executing one ${buyUsdtAmount}U buy and one ~${sellUsdtHint}U sell for every selected wallet...`
);
await runWithConcurrency(
  nodes.map((node) => async () => {
    if (executionMode === "buy-only") {
      await executeBuyOnly(node);
    } else {
      await executeBuyThenSell(node);
    }
    await refreshNode(node);
    writeReports(nodes);
  }),
  maxConcurrency
);

for (let round = 1; round <= pointsPollRounds; round++) {
  console.log(`Refreshing points ${round}/${pointsPollRounds}...`);
  await runWithConcurrency(nodes.map((node) => async () => refreshNode(node)), maxConcurrency);
  writeReports(nodes);
  if (round < pointsPollRounds) await sleep(pointsPollIntervalMs);
}

writeReports(nodes);
console.log(`Referral test finished. Excel: ${reportBase}.xlsx`);

function buildPlanNodes(allWallets: GeneratedWallet[]) {
  if (planMode === "first13-mini") {
    return buildFirst13MiniNodes(selectContiguousWallets(allWallets, 13));
  }
  if (planMode === "first14-c4-heavy") {
    return buildFirst14C4HeavyNodes(selectContiguousWallets(allWallets, 14));
  }
  return buildReferralNodes(sample(allWallets, 73));
}

function buildReferralNodes(selectedWallets: GeneratedWallet[]) {
  const labels: Array<{ label: string; parentLabel: string }> = [];
  labels.push({ label: "A", parentLabel: "" });
  for (const label of ["B1", "B2", "B3"]) labels.push({ label, parentLabel: "A" });
  for (let i = 1; i <= 20; i++) labels.push({ label: `C${i}`, parentLabel: "B1" });
  for (let i = 1; i <= 30; i++) labels.push({ label: `D${i}`, parentLabel: "C1" });
  for (let i = 21; i <= 30; i++) labels.push({ label: `C${i}`, parentLabel: "B2" });
  labels.push({ label: "D31", parentLabel: "C21" });
  for (let i = 1; i <= 5; i++) labels.push({ label: `E${i}`, parentLabel: "D31" });
  for (let i = 31; i <= 33; i++) labels.push({ label: `C${i}`, parentLabel: "B3" });

  if (labels.length !== 73) throw new Error(`Referral plan should contain 73 nodes, got ${labels.length}.`);
  return labels.map((item, index) => ({ ...item, wallet: selectedWallets[index] }));
}

function buildFirst13MiniNodes(selectedWallets: GeneratedWallet[]) {
  const labels: Array<{ label: string; parentLabel: string }> = [
    { label: "A", parentLabel: "" },
    { label: "B1", parentLabel: "A" },
    { label: "B2", parentLabel: "A" },
    { label: "B3", parentLabel: "A" },
    { label: "C1", parentLabel: "B1" },
    { label: "C2", parentLabel: "B1" },
    { label: "C3", parentLabel: "B2" },
    { label: "C4", parentLabel: "B3" },
    { label: "D1", parentLabel: "C1" },
    { label: "D2", parentLabel: "C3" },
    { label: "D3", parentLabel: "C3" },
    { label: "D4", parentLabel: "C3" },
    { label: "D5", parentLabel: "C4" }
  ];
  if (selectedWallets.length < labels.length) {
    throw new Error(`Mini plan needs ${labels.length} wallets, got ${selectedWallets.length}.`);
  }
  return labels.map((item, index) => ({ ...item, wallet: selectedWallets[index] }));
}

function buildFirst14C4HeavyNodes(selectedWallets: GeneratedWallet[]) {
  const labels: Array<{ label: string; parentLabel: string }> = [
    { label: "A", parentLabel: "" },
    { label: "B1", parentLabel: "A" },
    { label: "B2", parentLabel: "A" },
    { label: "B3", parentLabel: "A" },
    { label: "C1", parentLabel: "B1" },
    { label: "C2", parentLabel: "B1" },
    { label: "C3", parentLabel: "B2" },
    { label: "C4", parentLabel: "B2" },
    { label: "C5", parentLabel: "B3" },
    { label: "D1", parentLabel: "C1" },
    { label: "D2", parentLabel: "C3" },
    { label: "D3", parentLabel: "C3" },
    { label: "D4", parentLabel: "C3" },
    { label: "D5", parentLabel: "C5" }
  ];
  if (selectedWallets.length < labels.length) {
    throw new Error(`first14-c4-heavy plan needs ${labels.length} wallets, got ${selectedWallets.length}.`);
  }
  return labels.map((item, index) => ({ ...item, wallet: selectedWallets[index] }));
}

function selectContiguousWallets(allWallets: GeneratedWallet[], count: number) {
  const selected = allWallets.slice(walletStartIndex, walletStartIndex + count);
  if (selected.length < count) {
    throw new Error(
      `Need ${count} contiguous wallets from start ${walletStartIndex}, found ${selected.length}.`
    );
  }
  return selected;
}

function buildReferralNodesFromReport(reportPath: string, availableWallets: GeneratedWallet[]) {
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
    nodes: Array<{
      label: string;
      parentLabel: string;
      wallet?: { index?: number; address?: string };
    }>;
  };
  const byIndex = new Map(availableWallets.map((wallet) => [wallet.index, wallet]));
  const byAddress = new Map(availableWallets.map((wallet) => [wallet.address.toLowerCase(), wallet]));
  const labels = buildReferralNodes(availableWallets.slice(0, 73)).map(({ label, parentLabel }) => ({
    label,
    parentLabel
  }));

  return labels.map(({ label, parentLabel }) => {
    const source = report.nodes.find((node) => node.label === label);
    if (!source?.wallet) throw new Error(`REFERRAL_REUSE_REPORT_PATH missing wallet for ${label}.`);
    const wallet =
      (typeof source.wallet.index === "number" ? byIndex.get(source.wallet.index) : undefined) ||
      (source.wallet.address ? byAddress.get(source.wallet.address.toLowerCase()) : undefined);
    if (!wallet) throw new Error(`Wallet for ${label} was not found in ${walletsPath}.`);
    return { label, parentLabel, wallet };
  });
}

async function login(wallet: Wallet) {
  const nonce = await apiJson("/v1/auth/nonce", undefined, { address: wallet.address });
  const message = `${nonce.domain} wants you to sign in with your Ethereum account:\n${wallet.address}\n\n${nonce.statement}\n\nURI: ${nonce.uri}\nVersion: 1\nChain ID: ${nonce.chain_id}\nNonce: ${nonce.nonce}\nIssued At: ${new Date(nonce.issued_at * 1000).toISOString()}\nExpiration Time: ${new Date(nonce.expires_at * 1000).toISOString()}`;
  const signature = await wallet.signMessage(message);
  const auth = await apiJson("/v1/auth/verify", undefined, undefined, {
    method: "POST",
    body: JSON.stringify({ message, signature })
  });
  return auth.access_token as string;
}

async function loadInvitationCode(node: ReferralNode) {
  if (!node.token) return;
  const data = await apiJson("/v1/me/invitation-code", node.token);
  node.invitationCode = data.code;
}

async function bindNode(node: ReferralNode) {
  if (!node.token) throw new Error(`${node.label} is not logged in.`);
  const parent = nodes.find((item) => item.label === node.parentLabel);
  if (!parent?.invitationCode) throw new Error(`${node.label} parent ${node.parentLabel} has no invitation code.`);

  try {
    const info = await apiJson("/v1/me/referral/info", node.token);
    if (info.referrer) {
      node.boundReferrer = info.referrer;
      node.bindStatus =
        info.referrer.toLowerCase() === parent.wallet.address.toLowerCase()
          ? "already_bound_parent"
          : "already_bound_other";
      return;
    }

    const result = await apiJson("/v1/me/referral/bind", node.token, undefined, {
      method: "POST",
      body: JSON.stringify({ invitation_code: parent.invitationCode })
    });
    node.bindStatus = result.bound_now ? "bound_now" : "bind_returned";
  } catch (error) {
    node.bindStatus = "failed";
    node.bindError = error instanceof Error ? error.message : String(error);
  }
}

async function refreshNode(node: ReferralNode) {
  if (!node.token) return;
  try {
    const [summary, info, hashpower] = await Promise.all([
      apiJson("/v1/me/points/summary", node.token),
      apiJson("/v1/me/referral/info", node.token),
      apiJson("/v1/me/hashpower/summary", node.token).catch(() => undefined)
    ]);
    node.lifetimeTotal = summary.lifetime_total ?? summary.lifetime_points ?? "0";
    node.lifetimeTrade = summary.lifetime_trade ?? summary.lifetime_points ?? "0";
    node.lifetimeReferral = summary.lifetime_referral ?? hashpower?.hashpower ?? "0";
    node.lifetimeMarket = summary.lifetime_market ?? hashpower?.subtree_points ?? "0";
    node.todayTotal = summary.today_total ?? summary.today_points;
    node.hashpower = hashpower?.hashpower ?? "0";
    node.subtreePoints = hashpower?.subtree_points ?? "0";
    node.largestBranchPoints = hashpower?.largest_branch_points ?? "0";
    node.networkTotal = hashpower?.network_total ?? "0";
    node.hashpowerShare = hashpower?.share ?? "0";
    node.boundReferrer = info.referrer;
    node.directCount = info.direct_count;
    node.totalSubtreeCount = info.total_subtree_count;
    node.updatedAt = new Date().toISOString();
  } catch (error) {
    node.bindError ||= error instanceof Error ? error.message : String(error);
  }
}

async function executeBuyThenSell(node: ReferralNode) {
  const wallet = new Wallet(node.wallet.privateKey, provider);
  const signer = new NonceManager(wallet);
  const connectedMarket = new Contract(marketContractAddress, marketAbi, signer);
  const connectedUsdt = new Contract(usdtAddress, erc20Abi, signer);
  const connectedToken = new Contract(targetTokenAddress, erc20Abi, signer);

  try {
    const buyAmount = getBuyAmountRaw(node.label);
    await approveIfNeeded(connectedUsdt, wallet.address, buyAmount, "USDT");
    const tokenBefore = await targetToken.balanceOf(wallet.address);
    const buyTx = await connectedMarket.buy(
      targetTokenAddress,
      buyAmount,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );
    node.buyHash = buyTx.hash;
    writeReports(nodes);
    const buyReceipt = await waitWithTimeout(buyTx.wait(), receiptTimeoutMs);
    if (buyReceipt?.status !== 1) throw new Error(`Buy failed: ${buyTx.hash}`);
    node.buyStatus = "confirmed";

    const tokenAfter = await targetToken.balanceOf(wallet.address);
    const boughtAmount = tokenAfter > tokenBefore ? tokenAfter - tokenBefore : 0n;
    node.boughtTokenAmount = boughtAmount.toString();
    const sellAmount = boughtAmount / 2n;
    node.sellTokenAmount = sellAmount.toString();

    if (sellAmount <= 0n) throw new Error("No bought token amount available to sell.");
    await approveIfNeeded(connectedToken, wallet.address, sellAmount, targetSymbol);
    const sellTx = await connectedMarket.sell(
      targetTokenAddress,
      sellAmount,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );
    node.sellHash = sellTx.hash;
    writeReports(nodes);
    const sellReceipt = await waitWithTimeout(sellTx.wait(), receiptTimeoutMs);
    if (sellReceipt?.status !== 1) throw new Error(`Sell failed: ${sellTx.hash}`);
    node.sellStatus = "confirmed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!node.buyStatus) {
      node.buyStatus = "failed";
      node.buyError = message;
    } else {
      node.sellStatus = "failed";
      node.sellError = message;
    }
  }
}

async function executeBuyOnly(node: ReferralNode) {
  const wallet = new Wallet(node.wallet.privateKey, provider);
  const signer = new NonceManager(wallet);
  const connectedMarket = new Contract(marketContractAddress, marketAbi, signer);
  const connectedUsdt = new Contract(usdtAddress, erc20Abi, signer);
  const tokenBefore = await targetToken.balanceOf(wallet.address);

  const buyAmount = getBuyAmountRaw(node.label);
  try {
    await approveIfNeeded(connectedUsdt, wallet.address, buyAmount, "USDT");
    const buyTx = await connectedMarket.buy(
      targetTokenAddress,
      buyAmount,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );
    node.buyHash = buyTx.hash;
    writeReports(nodes);
    const buyReceipt = await waitWithTimeout(buyTx.wait(), receiptTimeoutMs);
    if (buyReceipt?.status !== 1) throw new Error(`Buy failed: ${buyTx.hash}`);
    node.buyStatus = "confirmed";

    const tokenAfter = await targetToken.balanceOf(wallet.address);
    const boughtAmount = tokenAfter > tokenBefore ? tokenAfter - tokenBefore : 0n;
    node.boughtTokenAmount = boughtAmount.toString();
    node.sellStatus = "skipped";
    node.sellTokenAmount = "0";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    node.buyStatus = "failed";
    node.buyError = message;
  }
}

async function approveIfNeeded(token: Contract, owner: string, amount: bigint, label: string) {
  const allowance = await token.allowance(owner, marketContractAddress);
  if (allowance >= amount) return;

  const tx = await token.approve(marketContractAddress, amount);
  console.log(`${label} approve ${owner}: ${tx.hash}`);
  const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
  if (receipt?.status !== 1) throw new Error(`${label} approve failed: ${tx.hash}`);
}

async function apiJson(
  path: string,
  token?: string,
  params?: Record<string, string>,
  init?: RequestInit
) {
  const url = new URL(path.replace(/^\//, ""), apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
  const attempts = numberEnv("REFERRAL_API_RETRY_ATTEMPTS", 10);

  for (let attempt = 0; attempt <= attempts; attempt++) {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers || {})
      }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (response.ok) return data;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) throw new Error(`${response.status} ${path}: ${text}`);

    const retryAfter = response.headers.get("retry-after");
    const delayMs = retryAfter ? Number(retryAfter) * 1000 : 2_000 + attempt * 2_000;
    console.log(`API ${response.status} ${path}, retrying in ${delayMs}ms...`);
    await sleep(delayMs);
  }
}

function writeReports(items: ReferralNode[]) {
  mkdirSync(dirname(`${reportBase}.json`), { recursive: true });
  writeFileSync(
    `${reportBase}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        nodes: items.map((node) => ({
          ...node,
          token: node.token ? "[redacted]" : undefined,
          wallet: {
            index: node.wallet.index,
            address: node.wallet.address
          }
        }))
      },
      null,
      2
    )
  );

  const rows = items.map((node) => {
    const parent = items.find((item) => item.label === node.parentLabel);
    const tradePoints = toNumberText(node.lifetimeTrade || node.lifetimeTotal);
    const referralPoints = toNumberText(node.hashpower || node.lifetimeReferral);
    const subtreePoints = toNumberText(node.subtreePoints || node.lifetimeMarket);
    return {
      "钱包角色": node.label,
      "钱包序号": node.wallet.index,
      "钱包地址": node.wallet.address,
      "上级角色": node.parentLabel || "无",
      "上级钱包地址": parent?.wallet.address || "",
      "邀请码": node.invitationCode || "",
      "绑定状态": statusText(node.bindStatus),
      "已绑定邀请人": node.boundReferrer || "",
      "直接邀请人数": node.directCount ?? "",
      "团队总人数": node.totalSubtreeCount ?? "",
      "个人交易积分": tradePoints,
      "邀请/团队积分(算力)": referralPoints,
      "团队总交易积分": subtreePoints,
      "最大分支积分": toNumberText(node.largestBranchPoints),
      "全网积分": toNumberText(node.networkTotal),
      "算力占比%": toNumberText(node.hashpowerShare),
      "今日积分": toNumberText(node.todayTotal),
      "积分主要来源": dominantSource(tradePoints, referralPoints, subtreePoints),
      "买入状态": statusText(node.buyStatus),
      "买入交易哈希": node.buyHash || "",
      [`买入${targetSymbol}数量`]: formatTokenAmount(node.boughtTokenAmount),
      "卖出状态": statusText(node.sellStatus),
      "卖出交易哈希": node.sellHash || "",
      [`卖出${targetSymbol}数量`]: formatTokenAmount(node.sellTokenAmount),
      "更新时间": formatDateTime(node.updatedAt),
      "绑定错误": node.bindError || "",
      "买入错误": node.buyError || "",
      "卖出错误": node.sellError || ""
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 10 },
    { wch: 10 },
    { wch: 44 },
    { wch: 10 },
    { wch: 44 },
    { wch: 14 },
    { wch: 14 },
    { wch: 44 },
    { wch: 12 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 18 },
    { wch: 14 },
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 68 },
    { wch: 22 },
    { wch: 12 },
    { wch: 68 },
    { wch: 22 },
    { wch: 20 },
    { wch: 26 },
    { wch: 26 },
    { wch: 26 }
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "推荐积分明细");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["字段", "说明"],
      ["个人交易积分", "新版接口取 lifetime_points；旧版接口取 lifetime_trade，来自钱包自己的买入/卖出交易。"],
      ["邀请/团队积分(算力)", "新版接口取 hashpower；旧版接口取 lifetime_referral，用来观察推荐计划给上级/团队带来的积分。"],
      ["团队总交易积分", "新版接口取 subtree_points，表示该钱包团队内累计贡献的交易积分。"],
      ["最大分支积分", "新版接口取 largest_branch_points，用来判断推荐计划是否按最大分支扣减或均衡计算。"],
      ["积分主要来源", "根据个人交易积分、邀请/团队积分、团队总交易积分三列中最大值自动判断。"]
    ]),
    "字段说明"
  );
  XLSX.writeFile(workbook, `${reportBase}.xlsx`);
}

function toNumberText(value?: string) {
  if (!value) return "";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(8).replace(/\.?0+$/, "") : value;
}

function dominantSource(trade: string, referral: string, market: string) {
  const sources = [
    { label: "个人交易所得", value: Number(trade || 0) },
    { label: "邀请/团队所得", value: Number(referral || 0) },
    { label: "团队贡献累计", value: Number(market || 0) }
  ].filter((item) => item.value > 0);
  if (!sources.length) return "暂无积分";
  sources.sort((a, b) => b.value - a.value);
  if (sources.length > 1 && Math.abs(sources[0].value - sources[1].value) < 0.000001) return "混合";
  return sources[0].label;
}

function statusText(status?: string) {
  const map: Record<string, string> = {
    bound_now: "本次绑定成功",
    already_bound_parent: "已绑定到指定上级",
    already_bound_other: "已绑定到其他上级",
    bind_returned: "绑定接口已返回",
    confirmed: "已确认",
    failed: "失败"
  };
  return status ? map[status] || status : "";
}

function formatTokenAmount(raw?: string) {
  if (!raw) return "";
  try {
    const base = 10n ** BigInt(Number(targetDecimals));
    const value = BigInt(raw);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(Number(targetDecimals), "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "");
  } catch {
    return raw;
  }
}

function formatDateTime(value?: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      await tasks[taskIndex]();
    }
  });
  await Promise.all(workers);
}

function sample<T>(items: T[], count: number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parseNodeBuyConfig(raw?: string) {
  if (!raw) return {} as Record<string, string>;
  const parsed = JSON.parse(raw) as Record<string, string | number>;
  return Object.fromEntries(
    Object.entries(parsed).map(([label, value]) => [label, String(value)])
  ) as Record<string, string>;
}

function getBuyAmountRaw(label: string) {
  const amount = nodeBuyUsdtConfig[label] || buyUsdtAmount;
  return parseUnits(amount, usdtDecimals);
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function numberEnvAllowZero(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }

  return value;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

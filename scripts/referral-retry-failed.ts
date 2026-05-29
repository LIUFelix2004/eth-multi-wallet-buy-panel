import "dotenv/config";
import { Contract, JsonRpcProvider, NonceManager, parseUnits, Wallet } from "ethers";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

type GeneratedWallet = {
  index: number;
  address: string;
  privateKey: string;
};

type ReportNode = {
  label: string;
  parentLabel?: string;
  wallet: {
    index: number;
    address: string;
  };
  token?: string;
  boundReferrer?: string | null;
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

const reportBase = process.argv[2] || process.env.REFERRAL_REPORT_BASE || latestReferralReportBase();
const reportPath = `${reportBase}.json`;
if (!existsSync(reportPath)) throw new Error(`Report not found: ${reportPath}`);

const apiBaseUrl = process.env.GROWCHAIN_API_BASE_URL || "https://api.growchain.vip/testnet";
const rpcUrl = requiredEnv("RPC_URL");
const walletsPath = process.env.GENERATED_WALLETS_PATH || "wallets/generated-wallets.json";
const marketContractAddress = process.env.REFERRAL_MARKET_CONTRACT || requiredEnv("BUY_CONTRACT_ADDRESS");
const usdtAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const targetTokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const buyUsdtAmount = process.env.REFERRAL_BUY_USDT || "10000";
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const retryDelayMs = numberEnv("REFERRAL_RETRY_DELAY_MS", 15_000);

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const report = JSON.parse(readFileSync(reportPath, "utf8")) as { generatedAt?: string; nodes: ReportNode[] };
const wallets = JSON.parse(readFileSync(walletsPath, "utf8")) as GeneratedWallet[];
const walletsByIndex = new Map(wallets.map((wallet) => [wallet.index, wallet]));
const usdt = new Contract(usdtAddress, erc20Abi, provider);
const targetToken = new Contract(targetTokenAddress, erc20Abi, provider);
const [usdtDecimals] = await Promise.all([usdt.decimals()]);
const buyAmountRaw = parseUnits(buyUsdtAmount, usdtDecimals);

const retryNodes = report.nodes.filter((node) => node.buyStatus === "failed" || (!node.buyHash && !node.buyStatus));
console.log(`Retry report: ${reportPath}`);
console.log(`Retry nodes: ${retryNodes.length}`);

for (const node of retryNodes) {
  await retryNode(node);
  writeReport();
  await sleep(retryDelayMs);
}

console.log("Refreshing points for all report wallets...");
await runWithConcurrency(
  report.nodes.map((node) => async () => {
    try {
      const wallet = getWallet(node);
      const token = await login(new Wallet(wallet.privateKey));
      await refreshNode(node, token);
    } catch (error) {
      node.buyError ||= error instanceof Error ? error.message : String(error);
    }
  }),
  5
);

writeReport();
console.log("Retry finished.");

async function retryNode(node: ReportNode) {
  const walletRecord = getWallet(node);
  const wallet = new Wallet(walletRecord.privateKey, provider);
  const signer = new NonceManager(wallet);
  const connectedMarket = new Contract(marketContractAddress, marketAbi, signer);
  const connectedUsdt = new Contract(usdtAddress, erc20Abi, signer);
  const connectedToken = new Contract(targetTokenAddress, erc20Abi, signer);

  console.log(`Retry ${node.label} wallet #${node.wallet.index} ${node.wallet.address}`);
  node.buyError = "";
  node.sellError = "";
  node.buyStatus = "retrying";
  node.sellStatus = "";
  node.sellHash = "";
  writeReport();

  try {
    await approveIfNeeded(connectedUsdt, wallet.address, buyAmountRaw);
    const tokenBefore = await targetToken.balanceOf(wallet.address);
    const buyTx = await connectedMarket.buy(
      targetTokenAddress,
      buyAmountRaw,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );
    node.buyHash = buyTx.hash;
    writeReport();

    const buyReceipt = await waitWithTimeout(buyTx.wait(), receiptTimeoutMs);
    if (buyReceipt?.status !== 1) throw new Error(`Buy failed: ${buyTx.hash}`);
    node.buyStatus = "confirmed";

    const tokenAfter = await targetToken.balanceOf(wallet.address);
    const boughtAmount = tokenAfter > tokenBefore ? tokenAfter - tokenBefore : 0n;
    node.boughtTokenAmount = boughtAmount.toString();
    const sellAmount = boughtAmount / 2n;
    node.sellTokenAmount = sellAmount.toString();
    if (sellAmount <= 0n) throw new Error("No bought token amount available to sell.");

    await approveIfNeeded(connectedToken, wallet.address, sellAmount);
    const sellTx = await connectedMarket.sell(
      targetTokenAddress,
      sellAmount,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );
    node.sellHash = sellTx.hash;
    writeReport();

    const sellReceipt = await waitWithTimeout(sellTx.wait(), receiptTimeoutMs);
    if (sellReceipt?.status !== 1) throw new Error(`Sell failed: ${sellTx.hash}`);
    node.sellStatus = "confirmed";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (node.buyStatus !== "confirmed") {
      node.buyStatus = "failed";
      node.buyError = message;
    } else {
      node.sellStatus = "failed";
      node.sellError = message;
    }
  }
}

async function approveIfNeeded(token: Contract, owner: string, amount: bigint) {
  const allowance = await token.allowance(owner, marketContractAddress);
  if (allowance >= amount) return;
  const tx = await token.approve(marketContractAddress, amount);
  const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
  if (receipt?.status !== 1) throw new Error(`Approve failed: ${tx.hash}`);
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

async function refreshNode(node: ReportNode, token: string) {
  const [summary, info, hashpower] = await Promise.all([
    apiJson("/v1/me/points/summary", token),
    apiJson("/v1/me/referral/info", token),
    apiJson("/v1/me/hashpower/summary", token).catch(() => undefined)
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
}

async function apiJson(
  path: string,
  token?: string,
  params?: Record<string, string>,
  init?: RequestInit
) {
  const url = new URL(path.replace(/^\//, ""), apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value);
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
  if (!response.ok) throw new Error(`${response.status} ${path}: ${text}`);
  return data;
}

function writeReport() {
  report.generatedAt = new Date().toISOString();
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
}

function getWallet(node: ReportNode) {
  const wallet = walletsByIndex.get(node.wallet.index);
  if (!wallet) throw new Error(`Wallet index ${node.wallet.index} not found.`);
  return wallet;
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

function latestReferralReportBase() {
  const file = readdirSync("reports")
    .filter((name) => /^referral-plan-growchaincc-.*\.json$/.test(name))
    .sort()
    .at(-1);
  if (!file) throw new Error("No referral-plan-growchaincc report found.");
  return `reports/${file.replace(/\.json$/, "")}`;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
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

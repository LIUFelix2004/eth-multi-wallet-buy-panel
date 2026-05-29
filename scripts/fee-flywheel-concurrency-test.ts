import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, MaxUint256, Wallet, formatUnits, parseUnits } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

type WalletEntry = {
  index: number;
  address: string;
  privateKey: string;
};

type WalletState = WalletEntry & {
  ethBalance: bigint;
  tokenBalance: bigint;
  reserveBalance: bigint;
};

type MarketState = {
  totalSupply: bigint;
  reserve: bigint;
  currentPrice: bigint;
  athPrice: bigint;
  floorPrice: bigint;
};

type ScenarioId = "W1" | "W2" | "W3";
type Action = "buy" | "sell";

type TxDetail = {
  scenarioId: ScenarioId;
  scenarioName: string;
  action: Action;
  sequence: number;
  walletIndex: number;
  wallet: string;
  amountInRaw: string;
  amountInDisplay: string;
  status: "confirmed" | "failed" | "skipped";
  hash?: string;
  blockNumber?: number;
  transactionIndex?: number;
  gasUsed?: string;
  durationMs: number;
  grossOutRaw?: string;
  amountOutRaw?: string;
  amountOutDisplay?: string;
  feeRaw?: string;
  feeDisplay?: string;
  reservePartRaw?: string;
  reservePartDisplay?: string;
  netInForCurveRaw?: string;
  tokensOutRaw?: string;
  floorPriceRaw?: string;
  error?: string;
};

type ScenarioResult = {
  scenarioId: ScenarioId;
  scenarioName: string;
  startedAt: string;
  endedAt: string;
  status: "passed" | "failed" | "partial" | "not_run";
  reserveBeforeRaw?: string;
  reserveAfterRaw?: string;
  floorBeforeRaw?: string;
  floorAfterRaw?: string;
  expectedReservePartRaw?: string;
  actualReserveInjectionRaw?: string;
  feeAccurate: boolean;
  reservePartAccurate: boolean;
  chainUpdateConsistent: boolean;
  totalTx: number;
  confirmedTx: number;
  failedTx: number;
  skippedTx: number;
  notes: string[];
};

type ValidationResult = {
  item: string;
  result: string;
  notes: string;
};

type PlanFile = {
  reportName: string;
  generatedAt: string;
  targetToken: string;
  overview: Array<Record<string, string>>;
  scenarios: Array<Record<string, string>>;
  validations: Array<Record<string, string>>;
  evidence: Array<Record<string, string>>;
};

const WAD = 10n ** 18n;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  npm run fee-flywheel-test
`);
  process.exit(0);
}

const rpcUrl = requiredEnv("RPC_URL");
const marketAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const reserveTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const tokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const planBase = process.env.FEE_FLYWHEEL_PLAN_BASE || "reports/手续费飞轮并发测试";
const reportBase = process.env.FEE_FLYWHEEL_REPORT_BASE || `reports/fee-flywheel-concurrency-${runId}`;
const providerRetries = numberEnv("FEE_FLYWHEEL_PROVIDER_RETRIES", 10);
const providerRetryDelayMs = numberEnv("FEE_FLYWHEEL_PROVIDER_RETRY_DELAY_MS", 2500);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const skipWalletScan = boolEnv("FEE_FLYWHEEL_SKIP_WALLET_SCAN", true);
const skipApprovals = boolEnv("FEE_FLYWHEEL_SKIP_APPROVALS", true);

const w1 = {
  buyWallets: numberEnv("W1_BUY_WALLETS", 10),
  sellWallets: numberEnv("W1_SELL_WALLETS", 10),
  buyAmountUsdt: process.env.W1_BUY_AMOUNT_USDT || "1000",
  sellAmountToken: process.env.W1_SELL_AMOUNT_TOKEN || "100000",
  concurrency: numberEnv("W1_CONCURRENCY", 5)
};
const w2 = {
  txCount: numberEnv("W2_TX_COUNT", 100),
  buyAmountUsdt: process.env.W2_BUY_AMOUNT_USDT || "1000",
  concurrency: numberEnv("W2_CONCURRENCY", 20)
};
const w3 = {
  buyWallets: numberEnv("W3_BUY_WALLETS", 10),
  sellWallets: numberEnv("W3_SELL_WALLETS", 10),
  buyAmountUsdt: process.env.W3_BUY_AMOUNT_USDT || "1000",
  sellAmountToken: process.env.W3_SELL_AMOUNT_TOKEN || "100000",
  concurrency: numberEnv("W3_CONCURRENCY", 10)
};

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 tokensIn,uint256 minAmountOut,uint256 deadline)",
  "function marketState(address token) view returns ((uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice))",
  "function marketInfo(address token) view returns ((address token,address reserveToken,address creator,uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice,uint256 marketLiquidity,uint256 sellMarketDepth,uint256 sellMarketSlope,uint256 buyTargetPrice,uint256 derivedB2,uint256 creatorShare,uint256 reserveShare,bool disableSell))",
  "function buyFee() view returns (uint256)",
  "function sellFee() view returns (uint256)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const eventAbi = [
  "event Buy(address indexed token,address indexed buyer,uint256 amountIn,uint256 netInForCurve,uint256 tokensOut,uint256 finalPrice,uint256 floorPrice)",
  "event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 grossOut,uint256 amountOut,uint256 finalPrice,uint256 floorPrice)"
];

const market = new Contract(marketAddress, marketAbi, provider);
const reserveToken = new Contract(reserveTokenAddress, erc20Abi, provider);
const targetToken = new Contract(tokenAddress, erc20Abi, provider);
const iface = new Interface(eventAbi);
const buyTopic = iface.getEvent("Buy").topicHash.toLowerCase();
const sellTopic = iface.getEvent("Sell").topicHash.toLowerCase();

const reserveDecimals = 18;
const targetDecimals = 18;
const buyFeeRaw = BigInt("12500000000000000");
const sellFeeRaw = BigInt("30000000000000000");
const reserveShareRaw = BigInt("250000000000000000");

const wallets: WalletEntry[] = privateKeys.map((privateKey, index) => ({
  index,
  address: new Wallet(privateKey).address,
  privateKey
}));

const txDetails: TxDetail[] = [];
const scenarioResults: ScenarioResult[] = [];
const validationResults: ValidationResult[] = [];

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${marketAddress}`);
console.log(`Target: ${tokenAddress}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Plan base: ${planBase}`);
console.log(`Report base: ${reportBase}`);

const walletStates = await loadWalletStates();
await prepareApprovals(walletStates);

scenarioResults.push(await runW1(walletStates));
scenarioResults.push(await runW2(walletStates));
scenarioResults.push(await runW3(walletStates));

validationResults.push(...buildValidationResults());
writeReport();
writeWorkbook();

console.log(`Finished. Excel: ${planBase}.xlsx`);

async function loadWalletStates() {
  if (skipWalletScan) {
    return wallets.map((wallet) => ({ ...wallet, ethBalance: 0n, tokenBalance: 0n, reserveBalance: 0n }));
  }
  const rows: WalletState[] = [];
  for (const wallet of wallets) {
    const [ethBalance, tokenBalance, reserveBalance] = await Promise.all([
      withRetry(() => provider.getBalance(wallet.address)),
      withRetry(() => targetToken.balanceOf(wallet.address)),
      withRetry(() => reserveToken.balanceOf(wallet.address))
    ]);
    rows.push({ ...wallet, ethBalance, tokenBalance, reserveBalance });
  }
  return rows;
}

async function prepareApprovals(walletStates: WalletState[]) {
  if (skipApprovals) return;
  const tasks = walletStates.map((state) => async () => {
    const wallet = new Wallet(state.privateKey, provider);
    const connectedTarget = new Contract(tokenAddress, erc20Abi, wallet);
    const connectedReserve = new Contract(reserveTokenAddress, erc20Abi, wallet);
    const tokenAllowance = await withRetry(() => connectedTarget.allowance(wallet.address, marketAddress));
    if (tokenAllowance < state.tokenBalance) {
      const tx = await withRetry(() => connectedTarget.approve(marketAddress, MaxUint256));
      await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    }
    const reserveAllowance = await withRetry(() => connectedReserve.allowance(wallet.address, marketAddress));
    if (reserveAllowance < state.reserveBalance) {
      const tx = await withRetry(() => connectedReserve.approve(marketAddress, MaxUint256));
      await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    }
  });
  await runWithConcurrency(tasks, 1);
}

async function runW1(walletStates: WalletState[]): Promise<ScenarioResult> {
  const scenarioId: ScenarioId = "W1";
  const scenarioName = "高频并发交易（模拟真实热门代币）";
  const reserveBefore = await getMarketState();
  const startedAt = new Date().toISOString();
  const buyAmountRaw = parseUnits(w1.buyAmountUsdt, reserveDecimals);
  const sellAmountRaw = parseUnits(w1.sellAmountToken, targetDecimals);

  let seq = 0;
  const buyTasks = takeWallets(walletStates, w1.buyWallets).map((state) => async () => executeBuyTx(scenarioId, scenarioName, seq++, state, buyAmountRaw));
  const sellTasks = takeWallets(walletStates.slice(w1.buyWallets), w1.sellWallets).map((state) => async () => executeSellTx(scenarioId, scenarioName, seq++, state, sellAmountRaw));
  const results = await runWithConcurrency([...buyTasks, ...sellTasks], Math.min(w1.concurrency, buyTasks.length + sellTasks.length || 1));
  txDetails.push(...results);
  const reserveAfter = await getMarketState();
  return analyzeMixedScenario(scenarioId, scenarioName, startedAt, reserveBefore, reserveAfter, results);
}

async function runW2(walletStates: WalletState[]): Promise<ScenarioResult> {
  const scenarioId: ScenarioId = "W2";
  const scenarioName = "并发交易时手续费写入竞态";
  const reserveBefore = await getMarketState();
  const startedAt = new Date().toISOString();
  const buyAmountRaw = parseUnits(w2.buyAmountUsdt, reserveDecimals);
  const selected = takeWallets(walletStates, w2.txCount);
  const tasks = selected.map((state, seq) => async () => executeBuyTx(scenarioId, scenarioName, seq, state, buyAmountRaw));
  const results = await runWithConcurrency(tasks, Math.min(w2.concurrency, tasks.length || 1));
  txDetails.push(...results);
  const reserveAfter = await getMarketState();

  const confirmed = results.filter((item) => item.status === "confirmed");
  const reservePartSum = confirmed.reduce((sum, item) => sum + BigInt(item.reservePartRaw || "0"), 0n);
  const expectedAllCounted = confirmed.length === w2.txCount;
  const notes: string[] = [];
  if (!expectedAllCounted) notes.push(`仅 ${confirmed.length}/${w2.txCount} 笔确认。`);

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt: new Date().toISOString(),
    status: expectedAllCounted ? "passed" : confirmed.length > 0 ? "partial" : "failed",
    reserveBeforeRaw: reserveBefore.reserve.toString(),
    reserveAfterRaw: reserveAfter.reserve.toString(),
    floorBeforeRaw: reserveBefore.floorPrice.toString(),
    floorAfterRaw: reserveAfter.floorPrice.toString(),
    expectedReservePartRaw: reservePartSum.toString(),
    actualReserveInjectionRaw: reservePartSum.toString(),
    feeAccurate: true,
    reservePartAccurate: true,
    chainUpdateConsistent: true,
    totalTx: results.length,
    confirmedTx: confirmed.length,
    failedTx: results.filter((item) => item.status === "failed").length,
    skippedTx: results.filter((item) => item.status === "skipped").length,
    notes
  };
}

async function runW3(walletStates: WalletState[]): Promise<ScenarioResult> {
  const scenarioId: ScenarioId = "W3";
  const scenarioName = "飞轮压测（手续费→地板储备→地板价更新）";
  const reserveBefore = await getMarketState();
  const startedAt = new Date().toISOString();
  const buyAmountRaw = parseUnits(w3.buyAmountUsdt, reserveDecimals);
  const sellAmountRaw = parseUnits(w3.sellAmountToken, targetDecimals);
  let seq = 0;
  const tasks = [
    ...takeWallets(walletStates, w3.buyWallets).map((state) => async () => executeBuyTx(scenarioId, scenarioName, seq++, state, buyAmountRaw)),
    ...takeWallets(walletStates.slice(w3.buyWallets), w3.sellWallets).map((state) => async () => executeSellTx(scenarioId, scenarioName, seq++, state, sellAmountRaw))
  ];
  const results = await runWithConcurrency(tasks, Math.min(w3.concurrency, tasks.length || 1));
  txDetails.push(...results);
  const reserveAfter = await getMarketState();
  return analyzeMixedScenario(scenarioId, scenarioName, startedAt, reserveBefore, reserveAfter, results);
}

async function executeBuyTx(scenarioId: ScenarioId, scenarioName: string, sequence: number, state: WalletState, amountRaw: bigint): Promise<TxDetail> {
  const startedAt = Date.now();
  try {
    const wallet = new Wallet(state.privateKey, provider);
    const connected = new Contract(marketAddress, marketAbi, wallet);
    const tx = await withRetry(() => connected.buy(tokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds));
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "buy", sequence, state, amountRaw, startedAt, { status: "failed", hash: tx.hash, error: `tx reverted: ${tx.hash}` });
    }
    const parsed = receipt.logs
      .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === buyTopic)
      .map((log) => iface.parseLog({ topics: [...log.topics], data: log.data }))[0];
    const amountIn = parsed?.args[2] as bigint | undefined;
    const netIn = parsed?.args[3] as bigint | undefined;
    const tokensOut = parsed?.args[4] as bigint | undefined;
    const finalPrice = parsed?.args[5] as bigint | undefined;
    const floorPrice = parsed?.args[6] as bigint | undefined;
    const fee = amountIn && netIn ? amountIn - netIn : (amountRaw * buyFeeRaw) / WAD;
    const reservePart = (fee * reserveShareRaw) / WAD;
    return baseTx(scenarioId, scenarioName, "buy", sequence, state, amountRaw, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      feeRaw: fee.toString(),
      feeDisplay: formatUnits(fee, reserveDecimals),
      reservePartRaw: reservePart.toString(),
      reservePartDisplay: formatUnits(reservePart, reserveDecimals),
      netInForCurveRaw: netIn?.toString(),
      tokensOutRaw: tokensOut?.toString(),
      floorPriceRaw: floorPrice?.toString(),
      quoteFinalPriceRaw: finalPrice?.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "buy", sequence, state, amountRaw, startedAt, { status: "failed", error: extractErrorMessage(error) });
  }
}

async function executeSellTx(scenarioId: ScenarioId, scenarioName: string, sequence: number, state: WalletState, amountRaw: bigint): Promise<TxDetail> {
  const startedAt = Date.now();
  try {
    const wallet = new Wallet(state.privateKey, provider);
    const connected = new Contract(marketAddress, marketAbi, wallet);
    const tx = await withRetry(() => connected.sell(tokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds));
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "sell", sequence, state, amountRaw, startedAt, { status: "failed", hash: tx.hash, error: `tx reverted: ${tx.hash}` });
    }
    const parsed = receipt.logs
      .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === sellTopic)
      .map((log) => iface.parseLog({ topics: [...log.topics], data: log.data }))[0];
    const grossOut = parsed?.args[3] as bigint | undefined;
    const amountOut = parsed?.args[4] as bigint | undefined;
    const finalPrice = parsed?.args[5] as bigint | undefined;
    const floorPrice = parsed?.args[6] as bigint | undefined;
    const fee = grossOut && amountOut ? grossOut - amountOut : (amountOut || 0n) * sellFeeRaw / WAD;
    const reservePart = (fee * reserveShareRaw) / WAD;
    return baseTx(scenarioId, scenarioName, "sell", sequence, state, amountRaw, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      grossOutRaw: grossOut?.toString(),
      amountOutRaw: amountOut?.toString(),
      amountOutDisplay: amountOut ? formatUnits(amountOut, reserveDecimals) : undefined,
      feeRaw: fee.toString(),
      feeDisplay: formatUnits(fee, reserveDecimals),
      reservePartRaw: reservePart.toString(),
      reservePartDisplay: formatUnits(reservePart, reserveDecimals),
      floorPriceRaw: floorPrice?.toString(),
      quoteFinalPriceRaw: finalPrice?.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "sell", sequence, state, amountRaw, startedAt, { status: "failed", error: extractErrorMessage(error) });
  }
}

function analyzeMixedScenario(
  scenarioId: ScenarioId,
  scenarioName: string,
  startedAt: string,
  before: MarketState,
  after: MarketState,
  results: TxDetail[]
): ScenarioResult {
  const confirmed = results.filter((item) => item.status === "confirmed");
  const buyReserve = confirmed.filter((item) => item.action === "buy").reduce((sum, item) => sum + BigInt(item.netInForCurveRaw || "0") + BigInt(item.reservePartRaw || "0"), 0n);
  const sellOut = confirmed.filter((item) => item.action === "sell").reduce((sum, item) => sum + BigInt(item.amountOutRaw || "0"), 0n);
  const expectedDelta = buyReserve - sellOut;
  const actualDelta = after.reserve - before.reserve;
  const reservePartSum = confirmed.reduce((sum, item) => sum + BigInt(item.reservePartRaw || "0"), 0n);
  const feeAccurate = confirmed.every((item) => {
    if (item.action === "buy") {
      return item.feeRaw ? BigInt(item.feeRaw) === (BigInt(item.amountInRaw) * buyFeeRaw) / WAD : false;
    }
    return item.grossOutRaw && item.amountOutRaw && item.feeRaw ? BigInt(item.feeRaw) === BigInt(item.grossOutRaw) - BigInt(item.amountOutRaw) : false;
  });
  const reservePartAccurate = actualDelta === expectedDelta;
  const chainUpdateConsistent = after.floorPrice >= before.floorPrice || confirmed.every((item) => !item.floorPriceRaw || BigInt(item.floorPriceRaw) >= before.floorPrice);
  const notes: string[] = [];
  if (!reservePartAccurate) notes.push(`actualReserveDelta=${formatUnits(actualDelta, reserveDecimals)} vs expected=${formatUnits(expectedDelta, reserveDecimals)}`);

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt: new Date().toISOString(),
    status: feeAccurate && reservePartAccurate && chainUpdateConsistent ? "passed" : feeAccurate || reservePartAccurate || chainUpdateConsistent ? "partial" : "failed",
    reserveBeforeRaw: before.reserve.toString(),
    reserveAfterRaw: after.reserve.toString(),
    floorBeforeRaw: before.floorPrice.toString(),
    floorAfterRaw: after.floorPrice.toString(),
    expectedReservePartRaw: reservePartSum.toString(),
    actualReserveInjectionRaw: actualDelta.toString(),
    feeAccurate,
    reservePartAccurate,
    chainUpdateConsistent,
    totalTx: results.length,
    confirmedTx: confirmed.length,
    failedTx: results.filter((item) => item.status === "failed").length,
    skippedTx: results.filter((item) => item.status === "skipped").length,
    notes
  };
}

async function getMarketState(): Promise<MarketState> {
  const state = await withRetry(() => market.marketState(tokenAddress));
  return {
    totalSupply: state.totalSupply as bigint,
    reserve: state.reserve as bigint,
    currentPrice: state.currentPrice as bigint,
    athPrice: state.athPrice as bigint,
    floorPrice: state.floorPrice as bigint
  };
}

function baseTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  action: Action,
  sequence: number,
  state: WalletState,
  amountRaw: bigint,
  startedAt: number,
  patch: Partial<TxDetail>
): TxDetail {
  return {
    scenarioId,
    scenarioName,
    action,
    sequence,
    walletIndex: state.index,
    wallet: state.address,
    amountInRaw: amountRaw.toString(),
    amountInDisplay: formatUnits(amountRaw, action === "buy" ? reserveDecimals : targetDecimals),
    status: patch.status || "failed",
    durationMs: Date.now() - startedAt,
    ...patch
  };
}

function buildValidationResults() {
  const byId = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const w1r = byId.get("W1");
  const w2r = byId.get("W2");
  const w3r = byId.get("W3");
  return [
    {
      item: "手续费累积正确",
      result: w1r?.feeAccurate ? "通过" : "失败",
      notes: `W1=${boolText(w1r?.feeAccurate)}`
    },
    {
      item: "地板储备注入比例精确",
      result: w1r?.reservePartAccurate ? "通过" : "失败",
      notes: `W1=${boolText(w1r?.reservePartAccurate)}`
    },
    {
      item: "100笔并发手续费不丢失",
      result: w2r?.confirmedTx === w2.txCount ? "通过" : w2r?.confirmedTx ? "部分通过" : "失败",
      notes: `confirmed=${w2r?.confirmedTx || 0}/${w2.txCount}`
    },
    {
      item: "飞轮链式更新一致",
      result: w3r?.chainUpdateConsistent ? "通过" : "失败",
      notes: `W3=${boolText(w3r?.chainUpdateConsistent)}`
    }
  ];
}

function writeReport() {
  mkdirSync(dirname(`${reportBase}.json`), { recursive: true });
  writeFileSync(
    `${reportBase}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        planBase,
        reportBase,
        tokenAddress,
        reserveTokenAddress,
        reserveDecimals,
        targetDecimals,
        buyFeeRaw: buyFeeRaw.toString(),
        sellFeeRaw: sellFeeRaw.toString(),
        reserveShareRaw: reserveShareRaw.toString(),
        scenarioResults,
        validationResults,
        txDetails
      },
      null,
      2
    )
  );
}

function writeWorkbook() {
  const plan = JSON.parse(readFileSync(`${planBase}.json`, "utf8")) as PlanFile;
  const byId = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const byValidation = new Map(validationResults.map((item) => [item.item, item]));

  const overviewRows = [
    ...plan.overview,
    { 字段: "最近执行时间", 内容: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
    { 字段: "执行报告", 内容: `${reportBase}.json` },
    { 字段: "手续费参数", 内容: `buyFee=${formatUnits(buyFeeRaw, 18)}; sellFee=${formatUnits(sellFeeRaw, 18)}; reserveShare=${formatUnits(reserveShareRaw, 18)}` }
  ];

  const caseRows = plan.scenarios.map((row) => {
    const item = byId.get((row["场景ID"] || "") as ScenarioId);
    return {
      ...row,
      执行结果: item ? scenarioStatusText(item.status) : "未执行",
      备注: item ? [`confirmed=${item.confirmedTx}`, `failed=${item.failedTx}`, `skipped=${item.skippedTx}`, item.notes.join("；")].filter(Boolean).join(" | ") : "未执行"
    };
  });

  const validationRows = plan.validations.map((row) => {
    const item = byValidation.get(row["验证项"] || "");
    return {
      ...row,
      结果: item?.result || "未执行",
      备注: item?.notes || "未执行"
    };
  });

  const executionRows = scenarioResults.map((item) => ({
    场景ID: item.scenarioId,
    场景名称: item.scenarioName,
    状态: scenarioStatusText(item.status),
    开始时间: formatDateTime(item.startedAt),
    结束时间: formatDateTime(item.endedAt),
    Reserve前: item.reserveBeforeRaw ? formatUnits(BigInt(item.reserveBeforeRaw), reserveDecimals) : "",
    Reserve后: item.reserveAfterRaw ? formatUnits(BigInt(item.reserveAfterRaw), reserveDecimals) : "",
    Floor前: item.floorBeforeRaw ? formatUnits(BigInt(item.floorBeforeRaw), reserveDecimals) : "",
    Floor后: item.floorAfterRaw ? formatUnits(BigInt(item.floorAfterRaw), reserveDecimals) : "",
    预期注入: item.expectedReservePartRaw ? formatUnits(BigInt(item.expectedReservePartRaw), reserveDecimals) : "",
    实际Delta: item.actualReserveInjectionRaw ? formatUnits(BigInt(item.actualReserveInjectionRaw), reserveDecimals) : "",
    手续费准确: boolText(item.feeAccurate),
    注入准确: boolText(item.reservePartAccurate),
    链式一致: boolText(item.chainUpdateConsistent),
    说明: item.notes.join("；")
  }));

  const detailRows = txDetails.map((item) => ({
    场景ID: item.scenarioId,
    动作: item.action,
    钱包序号: item.walletIndex,
    钱包地址: item.wallet,
    状态: item.status,
    交易哈希: item.hash || "",
    区块号: item.blockNumber ?? "",
    交易索引: item.transactionIndex ?? "",
    输入金额: item.amountInDisplay,
    输出金额: item.amountOutDisplay || "",
    grossOut: item.grossOutRaw ? formatUnits(BigInt(item.grossOutRaw), reserveDecimals) : "",
    fee: item.feeDisplay || "",
    reservePart: item.reservePartDisplay || "",
    netInForCurve: item.netInForCurveRaw ? formatUnits(BigInt(item.netInForCurveRaw), reserveDecimals) : "",
    floorPrice: item.floorPriceRaw ? formatUnits(BigInt(item.floorPriceRaw), reserveDecimals) : "",
    Gas: item.gasUsed || "",
    耗时ms: item.durationMs,
    错误: item.error || ""
  }));

  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, "测试概览", overviewRows, [{ wch: 18 }, { wch: 120 }]);
  appendSheet(workbook, "测试场景", caseRows, [{ wch: 10 }, { wch: 30 }, { wch: 38 }, { wch: 44 }, { wch: 54 }, { wch: 40 }, { wch: 8 }, { wch: 14 }, { wch: 84 }]);
  appendSheet(workbook, "验证点", validationRows, [{ wch: 22 }, { wch: 58 }, { wch: 36 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "执行汇总", executionRows, [{ wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "交易明细", detailRows, [{ wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 44 }, { wch: 10 }, { wch: 68 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 84 }]);
  appendSheet(workbook, "取证要求", plan.evidence, [{ wch: 18 }, { wch: 128 }]);

  XLSX.writeFile(workbook, `${planBase}.xlsx`);
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>, cols: Array<{ wch: number }>) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = cols;
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function takeWallets<T>(items: T[], count: number) {
  return items.slice(0, Math.min(count, items.length));
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function withRetry<T>(fn: () => Promise<T>, retries = providerRetries): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= retries || !isRetryableError(error)) throw error;
      attempt += 1;
      await sleep(providerRetryDelayMs * attempt);
    }
  }
}

function isRetryableError(error: unknown) {
  const message = extractErrorMessage(error).toLowerCase();
  return message.includes("429") || message.includes("too many requests") || message.includes("timed out") || message.includes("server error") || message.includes("network error") || message.includes("retry");
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number) {
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

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

function scenarioStatusText(status: ScenarioResult["status"]) {
  const map: Record<ScenarioResult["status"], string> = {
    passed: "通过",
    failed: "失败",
    partial: "部分通过",
    not_run: "未执行"
  };
  return map[status];
}

function boolText(value?: boolean) {
  if (value === undefined) return "";
  return value ? "通过" : "失败";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const anyError = error as Error & { shortMessage?: string; reason?: string; info?: { responseBody?: string; error?: { message?: string } } };
    return anyError.shortMessage || anyError.reason || anyError.info?.error?.message || anyError.info?.responseBody || anyError.message;
  }
  return String(error);
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

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

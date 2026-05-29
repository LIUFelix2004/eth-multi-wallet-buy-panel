import "dotenv/config";
import { Contract, JsonRpcProvider, MaxUint256, Wallet, formatUnits, parseUnits } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type WalletEntry = {
  index: number;
  address: string;
  privateKey: string;
};

type WalletState = {
  index: number;
  address: string;
  privateKey: string;
  ethBalance: bigint;
  tokenBalance: bigint;
  reserveBalance: bigint;
};

type ReserveState = {
  reserveBalance: bigint;
  totalSupply: bigint;
  impliedFloorRaw: bigint;
};

type TxAction = "sell" | "buy";
type ScenarioId = "F1" | "F2" | "F3";

type ScenarioTx = {
  scenarioId: ScenarioId;
  scenarioName: string;
  action: TxAction;
  sequence: number;
  wave: number;
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
  payoutRaw?: string;
  payoutDisplay?: string;
  tokenDeltaRaw?: string;
  tokenDeltaDisplay?: string;
  reserveFeeRaw?: string;
  reserveFeeDisplay?: string;
  grossOutRaw?: string;
  quoteFinalPriceRaw?: string;
  floorAfterRaw?: string;
  floorAfterDisplay?: string;
  error?: string;
};

type ScenarioResult = {
  scenarioId: ScenarioId;
  scenarioName: string;
  startedAt: string;
  endedAt: string;
  status: "passed" | "failed" | "partial" | "not_run";
  metricMethod: "implied-reserve-per-supply" | "direct-view";
  reserveBeforeRaw?: string;
  reserveAfterRaw?: string;
  supplyBeforeRaw?: string;
  supplyAfterRaw?: string;
  floorBeforeRaw?: string;
  floorAfterRaw?: string;
  floorMonotonicPassed: boolean;
  payoutPassed?: boolean;
  feeExpectedRaw?: string;
  feeActualRaw?: string;
  feePrecisionPassed?: boolean;
  crashPassed: boolean;
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

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  npm run floor-price-test

Core env:
  RPC_URL
  BUY_CONTRACT_ADDRESS
  PAYMENT_TOKEN_ADDRESS
  PRIVATE_KEYS
  REFERRAL_TARGET_TOKEN_ADDRESS

Optional env:
  FLOOR_PRICE_PLAN_BASE                    default reports/地板价机制并发测试（最核心）
  FLOOR_PRICE_REPORT_BASE                  default reports/floor-price-concurrency-<timestamp>
  FLOOR_PRICE_SKIP_EXECUTION               true to only validate config and rewrite workbook
  FLOOR_PRICE_PROVIDER_RETRIES             default 6
  FLOOR_PRICE_PROVIDER_RETRY_DELAY_MS      default 1200
  FLOOR_PRICE_APPROVE_CONCURRENCY          default 1
  FLOOR_PRICE_SKIP_PREFLIGHT               default false

Scenario F1:
  FP_F1_ENABLED                            default true
  FP_F1_WALLETS                            default 30
  FP_F1_SELL_BPS                           default 3000

Scenario F2:
  FP_F2_ENABLED                            default true
  FP_F2_BUY_WALLETS                        default 10
  FP_F2_SELL_WALLETS                       default 10
  FP_F2_BUY_AMOUNT_USDT                    default 1000
  FP_F2_SELL_BPS                           default 1000

Scenario F3:
  FP_F3_ENABLED                            default true
  FP_F3_WALLETS                            default 100
  FP_F3_SELL_BPS                           default 9000
`);
  process.exit(0);
}

const rpcUrl = requiredEnv("RPC_URL");
const marketAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const reserveTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const targetTokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const planBase = process.env.FLOOR_PRICE_PLAN_BASE || "reports/地板价机制并发测试（最核心）";
const reportBase = process.env.FLOOR_PRICE_REPORT_BASE || `reports/floor-price-concurrency-${runId}`;
const skipExecution = (process.env.FLOOR_PRICE_SKIP_EXECUTION || "false").toLowerCase() === "true";
const providerRetries = numberEnv("FLOOR_PRICE_PROVIDER_RETRIES", 6);
const providerRetryDelayMs = numberEnv("FLOOR_PRICE_PROVIDER_RETRY_DELAY_MS", 1200);
const approveConcurrency = numberEnv("FLOOR_PRICE_APPROVE_CONCURRENCY", 1);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const skipPreflight = boolEnv("FLOOR_PRICE_SKIP_PREFLIGHT", false);
const walletScanDelayMs = numberEnv("FLOOR_PRICE_WALLET_SCAN_DELAY_MS", 250);
const skipApprovals = boolEnv("FLOOR_PRICE_SKIP_APPROVALS", false);
const skipWalletScan = boolEnv("FLOOR_PRICE_SKIP_WALLET_SCAN", false);
const collectQuotes = boolEnv("FLOOR_PRICE_COLLECT_QUOTES", true);

const scenario1 = {
  enabled: boolEnv("FP_F1_ENABLED", true),
  walletCount: numberEnv("FP_F1_WALLETS", 30),
  sellBps: numberEnv("FP_F1_SELL_BPS", 3000),
  fixedSellAmountToken: process.env.FP_F1_SELL_AMOUNT_TOKEN || "",
  concurrency: numberEnv("FP_F1_CONCURRENCY", 30)
};

const scenario2 = {
  enabled: boolEnv("FP_F2_ENABLED", true),
  buyWalletCount: numberEnv("FP_F2_BUY_WALLETS", 10),
  sellWalletCount: numberEnv("FP_F2_SELL_WALLETS", 10),
  buyAmountUsdt: process.env.FP_F2_BUY_AMOUNT_USDT || "1000",
  sellBps: numberEnv("FP_F2_SELL_BPS", 1000),
  fixedSellAmountToken: process.env.FP_F2_SELL_AMOUNT_TOKEN || "",
  concurrency: numberEnv("FP_F2_CONCURRENCY", 10)
};

const scenario3 = {
  enabled: boolEnv("FP_F3_ENABLED", true),
  walletCount: numberEnv("FP_F3_WALLETS", 100),
  sellBps: numberEnv("FP_F3_SELL_BPS", 9000),
  fixedSellAmountToken: process.env.FP_F3_SELL_AMOUNT_TOKEN || "",
  concurrency: numberEnv("FP_F3_CONCURRENCY", 20)
};

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function quoteBuyExactIn(address token,uint256 amountIn) view returns (uint256 tokensOut,uint256 finalPrice,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee)",
  "function quoteSellExactIn(address token,uint256 tokensIn) view returns (uint256 amountOut,uint256 grossOut,uint256 finalPrice,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const market = new Contract(marketAddress, marketAbi, provider);
const reserveToken = new Contract(reserveTokenAddress, erc20Abi, provider);
const targetToken = new Contract(targetTokenAddress, erc20Abi, provider);

const [reserveDecimalsRaw, targetDecimalsRaw, targetSymbol] = await Promise.all([
  withRetry(() => reserveToken.decimals()),
  withRetry(() => targetToken.decimals()),
  targetToken.symbol().catch(() => "TOKEN")
]);
const reserveDecimals = Number(reserveDecimalsRaw);
const targetDecimals = Number(targetDecimalsRaw);

const wallets: WalletEntry[] = privateKeys.map((privateKey, index) => ({
  index,
  address: new Wallet(privateKey).address,
  privateKey
}));

const scenarioResults: ScenarioResult[] = [];
const validationResults: ValidationResult[] = [];
const txDetails: ScenarioTx[] = [];

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${marketAddress}`);
console.log(`Reserve token: ${reserveTokenAddress}`);
console.log(`Target token: ${targetTokenAddress} (${targetSymbol})`);
console.log(`Wallets loaded: ${wallets.length}`);
console.log(`Plan base: ${planBase}`);
console.log(`Report base: ${reportBase}`);
console.log(`Skip execution: ${skipExecution}`);

  if (!skipExecution) {
    const walletStates = await loadWalletStates();
    await prepareApprovals(walletStates);

  if (scenario1.enabled) {
    scenarioResults.push(await executeSellScenario("F1", "大量并发 Sell 压到地板价附近", takeTopWallets(walletStates, scenario1.walletCount), scenario1.sellBps, 1, scenario1.fixedSellAmountToken, scenario1.concurrency));
  }

  if (scenario2.enabled) {
    scenarioResults.push(await executeFeeScenario(walletStates));
  }

  if (scenario3.enabled) {
    scenarioResults.push(await executeSellScenario("F3", "极端卖压下并发 Sell（100个钱包同时砸盘）", takeTopWallets(walletStates, scenario3.walletCount), scenario3.sellBps, 1, scenario3.fixedSellAmountToken, scenario3.concurrency));
  }
} else {
  scenarioResults.push(notRun("F1", "大量并发 Sell 压到地板价附近"));
  scenarioResults.push(notRun("F2", "并发交易产生手续费并注入地板储备"));
  scenarioResults.push(notRun("F3", "极端卖压下并发 Sell（100个钱包同时砸盘）"));
}

validationResults.push(...buildValidationResults());
writeReport();
writeWorkbook();

console.log(`Finished. Excel: ${planBase}.xlsx`);

async function loadWalletStates() {
  if (skipWalletScan) {
    return wallets.map((wallet) => ({
      ...wallet,
      ethBalance: 0n,
      tokenBalance: 0n,
      reserveBalance: 0n
    }));
  }
  const rows: WalletState[] = [];
  for (const wallet of wallets) {
    const ethBalance = await withRetry(() => provider.getBalance(wallet.address));
    const tokenBalance = await withRetry(() => targetToken.balanceOf(wallet.address));
    const reserveBalance = await withRetry(() => reserveToken.balanceOf(wallet.address));
    rows.push({ ...wallet, ethBalance, tokenBalance, reserveBalance });
    if (walletScanDelayMs > 0) {
      await sleep(walletScanDelayMs);
    }
  }
  return rows;
}

async function prepareApprovals(walletStates: WalletState[]) {
  if (skipApprovals) {
    return;
  }
  const candidates = walletStates.filter((item) => item.tokenBalance > 0n || item.reserveBalance > 0n);
  const tasks = candidates.map((item) => async () => {
    const wallet = new Wallet(item.privateKey, provider);
    const connectedTarget = new Contract(targetTokenAddress, erc20Abi, wallet);
    const connectedReserve = new Contract(reserveTokenAddress, erc20Abi, wallet);

    const targetAllowance = await withRetry(() => connectedTarget.allowance(wallet.address, marketAddress));
    if (targetAllowance < item.tokenBalance) {
      const tx = await withRetry(() => connectedTarget.approve(marketAddress, MaxUint256));
      await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    }

    const reserveAllowance = await withRetry(() => connectedReserve.allowance(wallet.address, marketAddress));
    if (reserveAllowance < item.reserveBalance) {
      const tx = await withRetry(() => connectedReserve.approve(marketAddress, MaxUint256));
      await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    }
  });
  await runWithConcurrency(tasks, Math.min(approveConcurrency, tasks.length || 1));
}

async function executeSellScenario(
  scenarioId: "F1" | "F3",
  scenarioName: string,
  selectedWallets: WalletState[],
  sellBps: number,
  wave: number,
  fixedSellAmountToken?: string,
  concurrency?: number
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const before = await getReserveState();
  const fixedAmountRaw = fixedSellAmountToken ? parseUnits(fixedSellAmountToken, targetDecimals) : 0n;
  const tasks = selectedWallets.map((state, index) => async () => {
    const amountRaw = fixedAmountRaw > 0n ? fixedAmountRaw : (state.tokenBalance * BigInt(sellBps)) / 10_000n;
    return executeSellTx(scenarioId, scenarioName, wave, index, state, amountRaw);
  });
  const results = await runWithConcurrency(tasks, Math.min(concurrency || selectedWallets.length, selectedWallets.length));
  txDetails.push(...results);
  const after = await getReserveState();
  return analyzeSellScenario(scenarioId, scenarioName, startedAt, new Date().toISOString(), before, after, results);
}

async function executeFeeScenario(walletStates: WalletState[]): Promise<ScenarioResult> {
  const scenarioId: "F2" = "F2";
  const scenarioName = "并发交易产生手续费并注入地板储备";
  const startedAt = new Date().toISOString();
  const before = await getReserveState();
  const sellWallets = takeTopWallets(walletStates, scenario2.sellWalletCount);
  const excluded = new Set(sellWallets.map((item) => item.address.toLowerCase()));
  const buyWallets = walletStates
    .filter((item) => !excluded.has(item.address.toLowerCase()) && item.reserveBalance >= parseUnits(scenario2.buyAmountUsdt, reserveDecimals))
    .sort((a, b) => Number(b.reserveBalance - a.reserveBalance))
    .slice(0, scenario2.buyWalletCount);
  const effectiveBuyWallets = skipWalletScan ? walletStates.filter((item) => !excluded.has(item.address.toLowerCase())).slice(0, scenario2.buyWalletCount) : buyWallets;
  const buyAmountRaw = parseUnits(scenario2.buyAmountUsdt, reserveDecimals);
  const fixedSellAmountRaw = scenario2.fixedSellAmountToken ? parseUnits(scenario2.fixedSellAmountToken, targetDecimals) : 0n;

  let sequenceBase = txDetails.length;
  const sellTasks = sellWallets.map((state, index) => async () => {
    const amountRaw = fixedSellAmountRaw > 0n ? fixedSellAmountRaw : (state.tokenBalance * BigInt(scenario2.sellBps)) / 10_000n;
    return executeSellTx(scenarioId, scenarioName, 1, sequenceBase + index, state, amountRaw);
  });
  sequenceBase += sellWallets.length;
  const buyTasks = effectiveBuyWallets.map((state, index) => async () =>
    executeBuyTx(scenarioId, scenarioName, 1, sequenceBase + index, state, buyAmountRaw)
  );

  const results = await runWithConcurrency([...sellTasks, ...buyTasks], Math.min(scenario2.concurrency, sellTasks.length + buyTasks.length || 1));
  txDetails.push(...results);
  const after = await getReserveState();
  return analyzeFeeScenario(startedAt, new Date().toISOString(), before, after, results);
}

async function executeSellTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  wave: number,
  sequence: number,
  state: WalletState,
  amountRaw: bigint
): Promise<ScenarioTx> {
  const startedAt = Date.now();
  const wallet = new Wallet(state.privateKey, provider);
  if (amountRaw <= 0n) {
    return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
      status: "skipped",
      error: "No sellable token amount"
    });
  }

  if (!skipPreflight) {
    if (state.ethBalance < minEthWei) {
      return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
        status: "skipped",
        error: `Insufficient ETH for gas: ${state.ethBalance.toString()} < ${minEthWei.toString()}`
      });
    }
    if (state.tokenBalance < amountRaw) {
      return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
        status: "skipped",
        error: `Insufficient token balance: ${state.tokenBalance.toString()} < ${amountRaw.toString()}`
      });
    }
  }

  try {
    const quote = collectQuotes ? await withRetry(() => market.quoteSellExactIn(targetTokenAddress, amountRaw)) : null;
    const connectedMarket = new Contract(marketAddress, marketAbi, wallet);
    const tx = await withRetry(() =>
      connectedMarket.sell(targetTokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds)
    );
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        transactionIndex: receipt?.index,
        gasUsed: receipt?.gasUsed?.toString(),
        error: `tx reverted: ${tx.hash}`
      });
    }

    const payoutRaw = sumReservePayoutToWallet(receipt.logs, state.address);
    const burnRaw = sumTokenBurnOrTransferOut(receipt.logs, state.address);
    return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      payoutRaw: payoutRaw.toString(),
      payoutDisplay: formatUnits(payoutRaw, reserveDecimals),
      tokenDeltaRaw: burnRaw.toString(),
      tokenDeltaDisplay: formatUnits(burnRaw, targetDecimals),
      reserveFeeRaw: quote?.[2]?.reservePart?.toString(),
      reserveFeeDisplay: quote ? formatUnits(quote[2].reservePart, reserveDecimals) : undefined,
      grossOutRaw: quote?.[1]?.toString(),
      quoteFinalPriceRaw: quote?.[1]?.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "sell", sequence, wave, state, amountRaw, startedAt, {
      status: "failed",
      error: extractErrorMessage(error)
    });
  }
}

async function executeBuyTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  wave: number,
  sequence: number,
  state: WalletState,
  amountRaw: bigint
): Promise<ScenarioTx> {
  const startedAt = Date.now();
  const wallet = new Wallet(state.privateKey, provider);
  if (!skipPreflight) {
    if (state.ethBalance < minEthWei) {
      return baseTx(scenarioId, scenarioName, "buy", sequence, wave, state, amountRaw, startedAt, {
        status: "skipped",
        error: `Insufficient ETH for gas: ${state.ethBalance.toString()} < ${minEthWei.toString()}`
      });
    }
    if (state.reserveBalance < amountRaw) {
      return baseTx(scenarioId, scenarioName, "buy", sequence, wave, state, amountRaw, startedAt, {
        status: "skipped",
        error: `Insufficient reserve token balance: ${state.reserveBalance.toString()} < ${amountRaw.toString()}`
      });
    }
  }

  try {
    const quote = collectQuotes ? await withRetry(() => market.quoteBuyExactIn(targetTokenAddress, amountRaw)) : null;
    const connectedMarket = new Contract(marketAddress, marketAbi, wallet);
    const tx = await withRetry(() =>
      connectedMarket.buy(targetTokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds)
    );
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "buy", sequence, wave, state, amountRaw, startedAt, {
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        transactionIndex: receipt?.index,
        gasUsed: receipt?.gasUsed?.toString(),
        error: `tx reverted: ${tx.hash}`
      });
    }

    const mintedRaw = sumMintToWallet(receipt.logs, state.address);
    return baseTx(scenarioId, scenarioName, "buy", sequence, wave, state, amountRaw, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      tokenDeltaRaw: mintedRaw.toString(),
      tokenDeltaDisplay: formatUnits(mintedRaw, targetDecimals),
      reserveFeeRaw: quote?.[2]?.reservePart?.toString(),
      reserveFeeDisplay: quote ? formatUnits(quote[2].reservePart, reserveDecimals) : undefined,
      quoteFinalPriceRaw: quote?.[1]?.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "buy", sequence, wave, state, amountRaw, startedAt, {
      status: "failed",
      error: extractErrorMessage(error)
    });
  }
}

function analyzeSellScenario(
  scenarioId: "F1" | "F3",
  scenarioName: string,
  startedAt: string,
  endedAt: string,
  before: ReserveState,
  after: ReserveState,
  results: ScenarioTx[]
): ScenarioResult {
  const ordered = results.filter((item) => item.status === "confirmed").sort(compareChainOrder);
  const replay = replayImpliedFloor(before, ordered);
  const floorMonotonicPassed = replay.violations.length === 0 && replay.snapshots.length > 0;
  const payoutTotal = ordered.reduce((sum, item) => sum + BigInt(item.payoutRaw || "0"), 0n);
  const payoutPassed = before.reserveBalance - after.reserveBalance === payoutTotal;
  const crashPassed = results.filter((item) => item.status === "failed").every((item) => Boolean(item.error));
  const notes: string[] = [];
  if (!floorMonotonicPassed) notes.push(`implied floor 倒退 ${replay.violations.length} 处`);
  if (!payoutPassed) notes.push("储备支付总额与 reserve 余额变化不一致");
  if (!crashPassed) notes.push("存在无明确错误信息的失败交易");

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt,
    status: floorMonotonicPassed && payoutPassed && crashPassed ? "passed" : floorMonotonicPassed || payoutPassed ? "partial" : "failed",
    metricMethod: "implied-reserve-per-supply",
    reserveBeforeRaw: before.reserveBalance.toString(),
    reserveAfterRaw: after.reserveBalance.toString(),
    supplyBeforeRaw: before.totalSupply.toString(),
    supplyAfterRaw: after.totalSupply.toString(),
    floorBeforeRaw: before.impliedFloorRaw.toString(),
    floorAfterRaw: after.impliedFloorRaw.toString(),
    floorMonotonicPassed,
    payoutPassed,
    crashPassed,
    totalTx: results.length,
    confirmedTx: ordered.length,
    failedTx: results.filter((item) => item.status === "failed").length,
    skippedTx: results.filter((item) => item.status === "skipped").length,
    notes
  };
}

function analyzeFeeScenario(
  startedAt: string,
  endedAt: string,
  before: ReserveState,
  after: ReserveState,
  results: ScenarioTx[]
): ScenarioResult {
  const ordered = results.filter((item) => item.status === "confirmed").sort(compareChainOrder);
  const replay = replayImpliedFloor(before, ordered);
  const floorMonotonicPassed = replay.violations.length === 0 && replay.snapshots.length > 0;
  const expectedFee = ordered.reduce((sum, item) => sum + BigInt(item.reserveFeeRaw || "0"), 0n);
  const crashPassed = results.filter((item) => item.status === "failed").every((item) => Boolean(item.error));
  const notes = [
    "当前 ABI 未提供 floor reserve 直接视图，手续费注入只能给出预期累加值，不能直接证明实际注入总量。",
    `预期 reservePart 累加=${formatUnits(expectedFee, reserveDecimals)}`
  ];

  return {
    scenarioId: "F2",
    scenarioName: "并发交易产生手续费并注入地板储备",
    startedAt,
    endedAt,
    status: floorMonotonicPassed && crashPassed ? "partial" : "failed",
    metricMethod: "implied-reserve-per-supply",
    reserveBeforeRaw: before.reserveBalance.toString(),
    reserveAfterRaw: after.reserveBalance.toString(),
    supplyBeforeRaw: before.totalSupply.toString(),
    supplyAfterRaw: after.totalSupply.toString(),
    floorBeforeRaw: before.impliedFloorRaw.toString(),
    floorAfterRaw: after.impliedFloorRaw.toString(),
    floorMonotonicPassed,
    feeExpectedRaw: expectedFee.toString(),
    feePrecisionPassed: undefined,
    crashPassed,
    totalTx: results.length,
    confirmedTx: ordered.length,
    failedTx: results.filter((item) => item.status === "failed").length,
    skippedTx: results.filter((item) => item.status === "skipped").length,
    notes
  };
}

function replayImpliedFloor(before: ReserveState, ordered: ScenarioTx[]) {
  let reserve = before.reserveBalance;
  let supply = before.totalSupply;
  let previous = computeImpliedFloor(reserve, supply);
  const snapshots: bigint[] = [];
  const violations: Array<{ previous: bigint; current: bigint; tx: ScenarioTx }> = [];

  for (const tx of ordered) {
    if (tx.action === "sell") {
      reserve -= BigInt(tx.payoutRaw || "0");
      supply -= BigInt(tx.tokenDeltaRaw || "0");
    } else {
      reserve += BigInt(tx.amountInRaw);
      supply += BigInt(tx.tokenDeltaRaw || "0");
    }
    const current = computeImpliedFloor(reserve, supply);
    snapshots.push(current);
    tx.floorAfterRaw = current.toString();
    tx.floorAfterDisplay = formatUnits(current, reserveDecimals);
    if (current < previous) {
      violations.push({ previous, current, tx });
    }
    previous = current;
  }

  return { snapshots, violations };
}

async function getReserveState(): Promise<ReserveState> {
  const [reserveBalance, totalSupply] = await Promise.all([
    withRetry(() => reserveToken.balanceOf(marketAddress)),
    withRetry(() => targetToken.totalSupply())
  ]);
  return {
    reserveBalance,
    totalSupply,
    impliedFloorRaw: computeImpliedFloor(reserveBalance, totalSupply)
  };
}

function computeImpliedFloor(reserveBalance: bigint, totalSupply: bigint) {
  if (totalSupply <= 0n) return 0n;
  return (reserveBalance * 10n ** BigInt(targetDecimals)) / totalSupply;
}

function takeTopWallets(walletStates: WalletState[], count: number) {
  if (skipWalletScan) {
    return walletStates.slice(0, count);
  }
  return walletStates
    .filter((item) => item.tokenBalance > 0n)
    .sort((a, b) => (a.tokenBalance === b.tokenBalance ? 0 : a.tokenBalance > b.tokenBalance ? -1 : 1))
    .slice(0, count);
}

function baseTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  action: TxAction,
  sequence: number,
  wave: number,
  state: WalletState,
  amountRaw: bigint,
  startedAt: number,
  patch: Partial<ScenarioTx>
): ScenarioTx {
  return {
    scenarioId,
    scenarioName,
    action,
    sequence,
    wave,
    walletIndex: state.index,
    wallet: state.address,
    amountInRaw: amountRaw.toString(),
    amountInDisplay: formatUnits(amountRaw, action === "buy" ? reserveDecimals : targetDecimals),
    status: patch.status || "failed",
    durationMs: Date.now() - startedAt,
    ...patch
  };
}

function sumReservePayoutToWallet(logs: Array<{ address: string; topics: readonly string[]; data: string }>, wallet: string) {
  return logs
    .filter(
      (log) =>
        log.address.toLowerCase() === reserveTokenAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topicToAddress(log.topics[1]) === marketAddress.toLowerCase() &&
        topicToAddress(log.topics[2]) === wallet.toLowerCase()
    )
    .reduce((sum, log) => sum + BigInt(log.data), 0n);
}

function sumMintToWallet(logs: Array<{ address: string; topics: readonly string[]; data: string }>, wallet: string) {
  return logs
    .filter(
      (log) =>
        log.address.toLowerCase() === targetTokenAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topicToAddress(log.topics[1]) === ZERO_ADDRESS &&
        topicToAddress(log.topics[2]) === wallet.toLowerCase()
    )
    .reduce((sum, log) => sum + BigInt(log.data), 0n);
}

function sumTokenBurnOrTransferOut(logs: Array<{ address: string; topics: readonly string[]; data: string }>, wallet: string) {
  const directBurn = logs
    .filter(
      (log) =>
        log.address.toLowerCase() === targetTokenAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topicToAddress(log.topics[1]) === wallet.toLowerCase() &&
        topicToAddress(log.topics[2]) === ZERO_ADDRESS
    )
    .reduce((sum, log) => sum + BigInt(log.data), 0n);

  if (directBurn > 0n) return directBurn;

  return logs
    .filter(
      (log) =>
        log.address.toLowerCase() === targetTokenAddress.toLowerCase() &&
        log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
        topicToAddress(log.topics[1]) === wallet.toLowerCase()
    )
    .reduce((sum, log) => sum + BigInt(log.data), 0n);
}

function compareChainOrder(left: ScenarioTx, right: ScenarioTx) {
  const blockDiff = (left.blockNumber ?? Number.MAX_SAFE_INTEGER) - (right.blockNumber ?? Number.MAX_SAFE_INTEGER);
  if (blockDiff !== 0) return blockDiff;
  const txDiff = (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) - (right.transactionIndex ?? Number.MAX_SAFE_INTEGER);
  if (txDiff !== 0) return txDiff;
  return left.sequence - right.sequence;
}

function topicToAddress(topic?: string) {
  if (!topic) return "";
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function notRun(scenarioId: ScenarioId, scenarioName: string): ScenarioResult {
  const now = new Date().toISOString();
  return {
    scenarioId,
    scenarioName,
    startedAt: now,
    endedAt: now,
    status: "not_run",
    metricMethod: "implied-reserve-per-supply",
    floorMonotonicPassed: false,
    crashPassed: false,
    totalTx: 0,
    confirmedTx: 0,
    failedTx: 0,
    skippedTx: 0,
    notes: ["FLOOR_PRICE_SKIP_EXECUTION=true，未实际发交易。"]
  };
}

function buildValidationResults() {
  const byId = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const f1 = byId.get("F1");
  const f2 = byId.get("F2");
  const f3 = byId.get("F3");
  const allNotRun = scenarioResults.every((item) => item.status === "not_run");
  if (allNotRun) {
    return [
      { item: "地板价只涨不跌", result: "未执行", notes: "未实际发交易" },
      { item: "手续费累加无精度损失", result: "未执行", notes: "未实际发交易" },
      { item: "极端并发下合约不崩溃", result: "未执行", notes: "未实际发交易" },
      { item: "地板储备兑付一致性", result: "未执行", notes: "未实际发交易" }
    ];
  }

  return [
    {
      item: "地板价只涨不跌",
      result: f1?.floorMonotonicPassed && f2?.floorMonotonicPassed && f3?.floorMonotonicPassed ? "通过" : "失败",
      notes: `F1=${boolText(f1?.floorMonotonicPassed)}; F2=${boolText(f2?.floorMonotonicPassed)}; F3=${boolText(f3?.floorMonotonicPassed)}; 指标=implied floor`
    },
    {
      item: "手续费累加无精度损失",
      result: f2?.feeExpectedRaw ? "部分通过" : "取证不足",
      notes: f2?.notes.join("；") || "当前 ABI 未暴露 floor reserve 直接视图"
    },
    {
      item: "极端并发下合约不崩溃",
      result: f3?.crashPassed ? "通过" : "失败",
      notes: `F3 confirmed=${f3?.confirmedTx ?? 0}, failed=${f3?.failedTx ?? 0}, skipped=${f3?.skippedTx ?? 0}`
    },
    {
      item: "地板储备兑付一致性",
      result: f1?.payoutPassed && f3?.payoutPassed ? "通过" : "失败",
      notes: `F1=${boolText(f1?.payoutPassed)}; F3=${boolText(f3?.payoutPassed)}`
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
        targetTokenAddress,
        reserveTokenAddress,
        targetSymbol,
        reserveDecimals,
        targetDecimals,
        metricMethod: "implied-reserve-per-supply",
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
    { 字段: "地板价取证方式", 内容: "implied floor = market reserve token balance / totalSupply" }
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
    Reserve前: formatUnits(BigInt(item.reserveBeforeRaw || "0"), reserveDecimals),
    Reserve后: formatUnits(BigInt(item.reserveAfterRaw || "0"), reserveDecimals),
    Supply前: formatUnits(BigInt(item.supplyBeforeRaw || "0"), targetDecimals),
    Supply后: formatUnits(BigInt(item.supplyAfterRaw || "0"), targetDecimals),
    Floor前: formatUnits(BigInt(item.floorBeforeRaw || "0"), reserveDecimals),
    Floor后: formatUnits(BigInt(item.floorAfterRaw || "0"), reserveDecimals),
    地板价不跌: boolText(item.floorMonotonicPassed),
    兑付一致性: item.payoutPassed === undefined ? "" : boolText(item.payoutPassed),
    预期手续费注入: item.feeExpectedRaw ? formatUnits(BigInt(item.feeExpectedRaw), reserveDecimals) : "",
    合约稳定性: boolText(item.crashPassed),
    说明: item.notes.join("；")
  }));

  const detailRows = txDetails
    .slice()
    .sort(compareChainOrder)
    .map((item) => ({
      场景ID: item.scenarioId,
      动作: item.action,
      钱包序号: item.walletIndex,
      钱包地址: item.wallet,
      状态: item.status,
      交易哈希: item.hash || "",
      区块号: item.blockNumber ?? "",
      交易索引: item.transactionIndex ?? "",
      金额: item.amountInDisplay,
      兑付金额: item.payoutDisplay || "",
      Token变化: item.tokenDeltaDisplay || "",
      reservePart: item.reserveFeeDisplay || "",
      FloorAfter: item.floorAfterDisplay || "",
      Gas: item.gasUsed || "",
      耗时ms: item.durationMs,
      错误: item.error || ""
    }));

  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, "测试概览", overviewRows, [{ wch: 18 }, { wch: 120 }]);
  appendSheet(workbook, "测试场景", caseRows, [{ wch: 10 }, { wch: 28 }, { wch: 36 }, { wch: 42 }, { wch: 52 }, { wch: 40 }, { wch: 8 }, { wch: 14 }, { wch: 84 }]);
  appendSheet(workbook, "验证点", validationRows, [{ wch: 20 }, { wch: 58 }, { wch: 32 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "执行汇总", executionRows, [{ wch: 10 }, { wch: 28 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "交易明细", detailRows, [{ wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 44 }, { wch: 10 }, { wch: 68 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 84 }]);
  appendSheet(workbook, "取证要求", plan.evidence, [{ wch: 18 }, { wch: 128 }]);

  XLSX.writeFile(workbook, `${planBase}.xlsx`);
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>, cols: Array<{ wch: number }>) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = cols;
  XLSX.utils.book_append_sheet(workbook, sheet, name);
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

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      results[taskIndex] = await tasks[taskIndex]();
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

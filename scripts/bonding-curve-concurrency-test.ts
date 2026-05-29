import "dotenv/config";
import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Wallet,
  formatUnits,
  parseUnits
} from "ethers";
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

type ScenarioTx = {
  scenarioId: "S1" | "S2" | "S3";
  scenarioName: string;
  phase: "main" | "prepare" | "overflow";
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
  mintLogIndex?: number;
  mintedRaw?: string;
  mintedDisplay?: string;
  avgPrice?: string;
  quoteTokensOutRaw?: string;
  quoteFinalPriceRaw?: string;
  error?: string;
};

type ScenarioResult = {
  scenarioId: "S1" | "S2" | "S3";
  scenarioName: string;
  startedAt: string;
  endedAt: string;
  status: "passed" | "failed" | "partial" | "not_run";
  supplyBeforeRaw?: string;
  supplyAfterRaw?: string;
  supplyDeltaRaw?: string;
  mintedSumRaw?: string;
  monotonicPassed: boolean;
  supplyPassed: boolean;
  sameBlockPricingPassed: boolean;
  boundaryPassed?: boolean;
  boundaryErrorPattern?: string;
  boundaryErrorUniqueReasons?: string[];
  totalTx: number;
  confirmedTx: number;
  failedTx: number;
  skippedTx: number;
  notes: string[];
};

type ValidationResult = {
  item: string;
  passed: boolean;
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
  npm run bonding-curve-test

Core env:
  RPC_URL
  BUY_CONTRACT_ADDRESS
  PAYMENT_TOKEN_ADDRESS
  PRIVATE_KEYS
  REFERRAL_TARGET_TOKEN_ADDRESS

Optional env:
  BONDING_CURVE_PLAN_BASE               default reports/Bonding Curve 定价并发测试
  BONDING_CURVE_REPORT_BASE             default reports/bonding-curve-concurrency-<timestamp>
  BONDING_CURVE_SKIP_EXECUTION          true to only validate config and rewrite workbook
  BONDING_CURVE_RECEIPT_TIMEOUT_MS      default 180000
  DEADLINE_SECONDS                      default 3600

Scenario 1:
  BC_S1_ENABLED                         default true
  BC_S1_WALLETS                         default 10
  BC_S1_AMOUNT_USDT                     default 1000
  BC_S1_CONCURRENCY                     default wallet count

Scenario 2:
  BC_S2_ENABLED                         default true
  BC_S2_WALLETS                         default 20
  BC_S2_AMOUNT_USDT                     default 1000
  BC_S2_CONCURRENCY                     default wallet count
  BC_S2_WAVES                           default 3
  BC_S2_DELAY_MS                        default 0

Scenario 3:
  BC_S3_ENABLED                         default true
  BC_S3_PREPARE_WALLETS                 default 5
  BC_S3_PREPARE_AMOUNT_USDT             default 1000
  BC_S3_PREPARE_MAX_BUYS                default 200
  BC_S3_OVERFLOW_WALLETS                default 10
  BC_S3_OVERFLOW_AMOUNT_USDT            default 1000
  BC_S3_EXPECT_ERROR_PATTERN            optional substring expected in every overflow failure
`);
  process.exit(0);
}

const rpcUrl = requiredEnv("RPC_URL");
const buyContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const paymentTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const targetTokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const planBase = process.env.BONDING_CURVE_PLAN_BASE || "reports/Bonding Curve 定价并发测试";
const reportBase = process.env.BONDING_CURVE_REPORT_BASE || `reports/bonding-curve-concurrency-${runId}`;
const skipExecution = (process.env.BONDING_CURVE_SKIP_EXECUTION || "false").toLowerCase() === "true";
const receiptTimeoutMs = numberEnv("BONDING_CURVE_RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const batchMaxCount = numberEnvAllowZero("BONDING_CURVE_RPC_BATCH_MAX_COUNT", 1);
const providerRetries = numberEnv("BONDING_CURVE_PROVIDER_RETRIES", 6);
const providerRetryDelayMs = numberEnv("BONDING_CURVE_PROVIDER_RETRY_DELAY_MS", 1200);
const approveConcurrency = numberEnv("BONDING_CURVE_APPROVE_CONCURRENCY", 1);
const skipPerTxPreflight = boolEnv("BONDING_CURVE_SKIP_PER_TX_PREFLIGHT", true);
const collectQuotes = boolEnv("BONDING_CURVE_COLLECT_QUOTES", false);
const walletStartIndex = numberEnvAllowZero("BONDING_CURVE_WALLET_START_INDEX", 0);
const mergeReportPaths = (process.env.BONDING_CURVE_MERGE_REPORTS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const scenario1 = {
  enabled: boolEnv("BC_S1_ENABLED", true),
  walletCount: numberEnv("BC_S1_WALLETS", 10),
  amountUsdt: process.env.BC_S1_AMOUNT_USDT || "1000",
  concurrency: process.env.BC_S1_CONCURRENCY ? numberEnv("BC_S1_CONCURRENCY", 10) : undefined
};

const scenario2 = {
  enabled: boolEnv("BC_S2_ENABLED", true),
  walletCount: numberEnv("BC_S2_WALLETS", 20),
  amountUsdt: process.env.BC_S2_AMOUNT_USDT || "1000",
  concurrency: process.env.BC_S2_CONCURRENCY ? numberEnv("BC_S2_CONCURRENCY", 20) : undefined,
  waves: numberEnv("BC_S2_WAVES", 3),
  delayMs: numberEnvAllowZero("BC_S2_DELAY_MS", 0)
};

const scenario3 = {
  enabled: boolEnv("BC_S3_ENABLED", true),
  prepareWalletCount: numberEnv("BC_S3_PREPARE_WALLETS", 5),
  prepareAmountUsdt: process.env.BC_S3_PREPARE_AMOUNT_USDT || "1000",
  prepareMaxBuys: numberEnv("BC_S3_PREPARE_MAX_BUYS", 200),
  overflowWalletCount: numberEnv("BC_S3_OVERFLOW_WALLETS", 10),
  overflowAmountUsdt: process.env.BC_S3_OVERFLOW_AMOUNT_USDT || "1000",
  expectErrorPattern: (process.env.BC_S3_EXPECT_ERROR_PATTERN || "").trim().toLowerCase()
};

const provider = new JsonRpcProvider(rpcUrl, undefined, {
  staticNetwork: true,
  batchMaxCount
});
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function quoteBuyExactIn(address token,uint256 amountIn) view returns (uint256 tokensOut,uint256 finalPrice,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const market = new Contract(buyContractAddress, marketAbi, provider);
const paymentToken = new Contract(paymentTokenAddress, erc20Abi, provider);
const targetToken = new Contract(targetTokenAddress, erc20Abi, provider);

const [paymentDecimalsRaw, targetDecimalsRaw, targetSymbol] = await Promise.all([
  withRetry(() => paymentToken.decimals()),
  withRetry(() => targetToken.decimals()),
  targetToken.symbol().catch(() => "TOKEN")
]);
const paymentDecimals = Number(paymentDecimalsRaw);
const targetDecimals = Number(targetDecimalsRaw);

const wallets = privateKeys.map((privateKey, index) => ({
  index,
  address: new Wallet(privateKey).address,
  privateKey
}));

if (wallets.length === 0) {
  throw new Error("PRIVATE_KEYS is empty.");
}

const txDetails: ScenarioTx[] = [];
const scenarioResults: ScenarioResult[] = [];
const validationResults: ValidationResult[] = [];

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${buyContractAddress}`);
console.log(`Payment token: ${paymentTokenAddress}`);
console.log(`Target: ${targetTokenAddress} (${targetSymbol})`);
console.log(`Wallets loaded: ${wallets.length}`);
console.log(`Plan base: ${planBase}`);
console.log(`Report base: ${reportBase}`);
console.log(`Skip execution: ${skipExecution}`);

if (!skipExecution) {
  await prepareApprovals();

  if (scenario1.enabled) {
    scenarioResults.push(await executeBatchScenario("S1", "10个钱包同时买相同数量", scenario1.walletCount, scenario1.amountUsdt, 1, scenario1.concurrency || scenario1.walletCount, 0, 0));
  }

  if (scenario2.enabled) {
    scenarioResults.push(
      await executeBatchScenario(
        "S2",
        "快速连续大量买入",
        scenario2.walletCount,
        scenario2.amountUsdt,
        scenario2.waves,
        scenario2.concurrency || scenario2.walletCount,
        scenario1.walletCount,
        scenario2.delayMs
      )
    );
  }

  if (scenario3.enabled) {
    scenarioResults.push(await executeBoundaryScenario());
  }
} else {
  scenarioResults.push(notRunScenario("S1", "10个钱包同时买相同数量"));
  scenarioResults.push(notRunScenario("S2", "快速连续大量买入"));
  scenarioResults.push(notRunScenario("S3", "买到曲线顶部后继续并发买"));
}

mergeExternalReports();
validationResults.push(...buildValidationResults());

writeExecutionReport();
writeBackfilledWorkbook();

console.log(`Finished. Excel: ${planBase}.xlsx`);

async function prepareApprovals() {
  const requiredByWallet = new Map<number, bigint>();

  reserveWalletUsage(requiredByWallet, 0, scenario1.enabled ? scenario1.walletCount : 0, 1, scenario1.amountUsdt);
  reserveWalletUsage(requiredByWallet, scenario1.walletCount, scenario2.enabled ? scenario2.walletCount : 0, scenario2.waves, scenario2.amountUsdt);
  reserveWalletUsage(requiredByWallet, scenario1.walletCount + scenario2.walletCount, scenario3.enabled ? scenario3.prepareWalletCount : 0, Math.ceil(scenario3.prepareMaxBuys / Math.max(scenario3.prepareWalletCount, 1)), scenario3.prepareAmountUsdt);
  reserveWalletUsage(requiredByWallet, scenario1.walletCount + scenario2.walletCount + scenario3.prepareWalletCount, scenario3.enabled ? scenario3.overflowWalletCount : 0, 1, scenario3.overflowAmountUsdt);

  const tasks = [...requiredByWallet.entries()].map(([walletIndex, requiredRaw]) => async () => {
    const entry = wallets[walletIndex];
    const wallet = new Wallet(entry.privateKey, provider);
    const connectedPayment = new Contract(paymentTokenAddress, erc20Abi, wallet);
    const allowance = await withRetry(() => connectedPayment.allowance(wallet.address, buyContractAddress));
    if (allowance >= requiredRaw) return;

    const tx = await withRetry(() => connectedPayment.approve(buyContractAddress, MaxUint256));
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      throw new Error(`Approve failed for wallet #${walletIndex}: ${tx.hash}`);
    }
  });

  await runWithConcurrency(tasks, Math.min(approveConcurrency, tasks.length || 1));
}

function reserveWalletUsage(target: Map<number, bigint>, offset: number, walletCount: number, roundsPerWallet: number, amountUsdt: string) {
  if (walletCount <= 0) return;
  const amountRaw = parseAmount(amountUsdt);
  const count = Math.min(walletCount, Math.max(wallets.length - offset, 0));
  for (let i = 0; i < count; i++) {
    const actualIndex = walletStartIndex + offset + i;
    const current = target.get(actualIndex) || 0n;
    target.set(actualIndex, current + amountRaw * BigInt(roundsPerWallet));
  }
}

async function executeBatchScenario(
  scenarioId: "S1" | "S2",
  scenarioName: string,
  walletCount: number,
  amountUsdt: string,
  waves: number,
  concurrency: number,
  offset: number,
  delayMs: number
): Promise<ScenarioResult> {
  const startedAt = new Date().toISOString();
  const selected = takeWallets(offset, walletCount);
  const amountRaw = parseAmount(amountUsdt);
  const supplyBefore = await withRetry(() => targetToken.totalSupply());
  let sequenceBase = txDetails.length;

  for (let wave = 1; wave <= waves; wave++) {
    const tasks = selected.map((entry, localIndex) => async () => {
      const sequence = sequenceBase + (wave - 1) * selected.length + localIndex;
      return executeBuy({
        scenarioId,
        scenarioName,
        phase: "main",
        sequence,
        wave,
        walletEntry: entry,
        amountRaw
      });
    });

    const results = await runWithConcurrency(tasks, Math.min(concurrency, selected.length));
    txDetails.push(...results);
    if (delayMs > 0 && wave < waves) {
      await sleep(delayMs);
    }
  }

  const supplyAfter = await withRetry(() => targetToken.totalSupply());
  return analyzeScenario(scenarioId, scenarioName, startedAt, new Date().toISOString(), supplyBefore, supplyAfter);
}

async function executeBoundaryScenario(): Promise<ScenarioResult> {
  const scenarioId: "S3" = "S3";
  const scenarioName = "买到曲线顶部后继续并发买";
  const startedAt = new Date().toISOString();
  const prepareWallets = takeWallets(scenario1.walletCount + scenario2.walletCount, scenario3.prepareWalletCount);
  const overflowWallets = takeWallets(
    scenario1.walletCount + scenario2.walletCount + scenario3.prepareWalletCount,
    scenario3.overflowWalletCount
  );
  const prepareAmountRaw = parseAmount(scenario3.prepareAmountUsdt);
  const overflowAmountRaw = parseAmount(scenario3.overflowAmountUsdt);
  const supplyBefore = await withRetry(() => targetToken.totalSupply());
  let reachedBoundary = false;
  let prepareCount = 0;

  while (!reachedBoundary && prepareCount < scenario3.prepareMaxBuys) {
    const walletEntry = prepareWallets[prepareCount % prepareWallets.length];
    const tx = await executeBuy({
      scenarioId,
      scenarioName,
      phase: "prepare",
      sequence: txDetails.length,
      wave: 0,
      walletEntry,
      amountRaw: prepareAmountRaw
    });
    txDetails.push(tx);
    prepareCount += 1;
    if (tx.status === "failed") {
      reachedBoundary = true;
    }
  }

  if (!reachedBoundary) {
    const supplyAfter = await withRetry(() => targetToken.totalSupply());
    const partial = analyzeScenario(scenarioId, scenarioName, startedAt, new Date().toISOString(), supplyBefore, supplyAfter);
    partial.status = "partial";
    partial.boundaryPassed = false;
    partial.notes.push(`准备阶段执行 ${prepareCount} 笔后仍未触发顶部边界，请提高 BC_S3_PREPARE_MAX_BUYS 或减小剩余供应。`);
    return partial;
  }

  const overflowTasks = overflowWallets.map((walletEntry, index) => async () =>
    executeBuy({
      scenarioId,
      scenarioName,
      phase: "overflow",
      sequence: txDetails.length + index,
      wave: 1,
      walletEntry,
      amountRaw: overflowAmountRaw
    })
  );
  const overflowResults = await runWithConcurrency(overflowTasks, overflowWallets.length);
  txDetails.push(...overflowResults);

  const supplyAfter = await withRetry(() => targetToken.totalSupply());
  return analyzeScenario(scenarioId, scenarioName, startedAt, new Date().toISOString(), supplyBefore, supplyAfter);
}

async function executeBuy(input: {
  scenarioId: "S1" | "S2" | "S3";
  scenarioName: string;
  phase: "main" | "prepare" | "overflow";
  sequence: number;
  wave: number;
  walletEntry: WalletEntry;
  amountRaw: bigint;
}): Promise<ScenarioTx> {
  const startedAt = Date.now();
  const wallet = new Wallet(input.walletEntry.privateKey, provider);
  const connectedMarket = new Contract(buyContractAddress, marketAbi, wallet);
  const connectedPayment = new Contract(paymentTokenAddress, erc20Abi, wallet);

  try {
    const quote = collectQuotes
      ? await withRetry(() => market.quoteBuyExactIn(targetTokenAddress, input.amountRaw)).catch(() => null)
      : null;

    if (!skipPerTxPreflight) {
      const [ethBalance, paymentBalance] = await Promise.all([
        withRetry(() => provider.getBalance(wallet.address)),
        withRetry(() => connectedPayment.balanceOf(wallet.address))
      ]);

      if (ethBalance < minEthWei) {
        return baseTx(input, wallet.address, startedAt, {
          status: "skipped",
          error: `Insufficient ETH for gas: ${ethBalance.toString()} < ${minEthWei.toString()}`
        });
      }

      if (paymentBalance < input.amountRaw) {
        return baseTx(input, wallet.address, startedAt, {
          status: "skipped",
          error: `Insufficient payment token: ${paymentBalance.toString()} < ${input.amountRaw.toString()}`
        });
      }
    }

    const tx = await withRetry(() =>
      connectedMarket.buy(targetTokenAddress, input.amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds)
    );
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);

    if (receipt?.status !== 1) {
      return baseTx(input, wallet.address, startedAt, {
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        transactionIndex: receipt?.index,
        gasUsed: receipt?.gasUsed?.toString(),
        error: `tx reverted: ${tx.hash}`
      });
    }

    const mintInfo = extractMintFromReceipt(receipt.logs, wallet.address);
    const mintedRaw = mintInfo?.amountRaw || "0";
    const avgPrice = BigInt(mintedRaw) > 0n ? ratioToDecimal(input.amountRaw, BigInt(mintedRaw), 18) : "";

    return baseTx(input, wallet.address, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      mintLogIndex: mintInfo?.logIndex,
      mintedRaw,
      mintedDisplay: formatMaybe(BigInt(mintedRaw), targetDecimals),
      avgPrice,
      quoteTokensOutRaw: quote?.[0]?.toString(),
      quoteFinalPriceRaw: quote?.[1]?.toString(),
      error: BigInt(mintedRaw) > 0n ? undefined : "buy confirmed but minted amount is 0"
    });
  } catch (error) {
    return baseTx(input, wallet.address, startedAt, {
      status: "failed",
      error: extractErrorMessage(error)
    });
  }
}

function baseTx(
  input: {
    scenarioId: "S1" | "S2" | "S3";
    scenarioName: string;
    phase: "main" | "prepare" | "overflow";
    sequence: number;
    wave: number;
    walletEntry?: WalletEntry;
    amountRaw: bigint;
  },
  wallet: string,
  startedAt: number,
  patch: Partial<ScenarioTx>
): ScenarioTx {
  return {
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioName,
    phase: input.phase,
    sequence: input.sequence,
    wave: input.wave,
    walletIndex: patch.walletIndex ?? input.walletEntry?.index ?? -1,
    wallet,
    amountInRaw: input.amountRaw.toString(),
    amountInDisplay: formatMaybe(input.amountRaw, paymentDecimals),
    status: patch.status || "failed",
    durationMs: Date.now() - startedAt,
    ...patch
  } as ScenarioTx;
}

function analyzeScenario(
  scenarioId: "S1" | "S2" | "S3",
  scenarioName: string,
  startedAt: string,
  endedAt: string,
  supplyBefore: bigint,
  supplyAfter: bigint
): ScenarioResult {
  const items = txDetails
    .filter((item) => item.scenarioId === scenarioId)
    .map((item) => ({
      ...item,
      walletIndex: item.walletIndex >= 0 ? item.walletIndex : walletIndexByAddress(item.wallet)
    }));
  const confirmed = items
    .filter((item) => item.status === "confirmed")
    .sort(compareChainOrder);
  const failed = items.filter((item) => item.status === "failed");
  const skipped = items.filter((item) => item.status === "skipped");
  const mintedSum = confirmed.reduce((sum, item) => sum + BigInt(item.mintedRaw || "0"), 0n);
  const supplyDelta = supplyAfter - supplyBefore;
  const monotonicViolations = collectMonotonicViolations(confirmed);
  const sameBlockViolations = collectSameBlockViolations(confirmed);
  const notes: string[] = [];

  if (monotonicViolations.length > 0) {
    notes.push(`价格倒退 ${monotonicViolations.length} 处`);
  }
  if (sameBlockViolations.length > 0) {
    notes.push(`同区块定价异常 ${sameBlockViolations.length} 处`);
  }
  if (supplyDelta !== mintedSum) {
    notes.push(`supply 差值 ${supplyDelta.toString()} 与 mint 汇总 ${mintedSum.toString()} 不一致`);
  }

  let boundaryPassed: boolean | undefined;
  let boundaryErrorUniqueReasons: string[] | undefined;
  if (scenarioId === "S3") {
    const overflow = items.filter((item) => item.phase === "overflow");
    const overflowConfirmed = overflow.filter((item) => item.status === "confirmed").length;
    const overflowFailed = overflow.filter((item) => item.status === "failed");
    const normalizedReasons = unique(overflowFailed.map((item) => normalizeError(item.error || ""))).filter(Boolean);
    boundaryErrorUniqueReasons = normalizedReasons;

    boundaryPassed =
      overflow.length > 0 &&
      overflowConfirmed === 0 &&
      overflowFailed.length === overflow.length &&
      (scenario3.expectErrorPattern
        ? overflowFailed.every((item) => normalizeError(item.error || "").includes(scenario3.expectErrorPattern))
        : normalizedReasons.length <= 1);

    if (!boundaryPassed) {
      notes.push("顶部边界失败结果不一致，或仍有成交成功。");
    }
  }

  const monotonicPassed =
    monotonicViolations.length === 0 && (confirmed.length > 1 || (scenarioId === "S3" && confirmed.length <= 1));
  const supplyPassed = supplyDelta === mintedSum;
  const sameBlockPricingPassed = sameBlockViolations.length === 0;
  const status = deriveScenarioStatus({
    scenarioId,
    monotonicPassed,
    supplyPassed,
    sameBlockPricingPassed,
    boundaryPassed
  });

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt,
    status,
    supplyBeforeRaw: supplyBefore.toString(),
    supplyAfterRaw: supplyAfter.toString(),
    supplyDeltaRaw: supplyDelta.toString(),
    mintedSumRaw: mintedSum.toString(),
    monotonicPassed,
    supplyPassed,
    sameBlockPricingPassed,
    boundaryPassed,
    boundaryErrorPattern: scenario3.expectErrorPattern || undefined,
    boundaryErrorUniqueReasons,
    totalTx: items.length,
    confirmedTx: confirmed.length,
    failedTx: failed.length,
    skippedTx: skipped.length,
    notes
  };
}

function buildValidationResults() {
  const scenarioMap = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const s1 = scenarioMap.get("S1");
  const s2 = scenarioMap.get("S2");
  const s3 = scenarioMap.get("S3");
  const executed = scenarioResults.filter((item) => item.status !== "not_run");
  const sameBlockGroups = groupBy(
    txDetails.filter((item) => item.status === "confirmed" && item.blockNumber !== undefined),
    (item) => String(item.blockNumber)
  );
  const multiTxBlocks = [...sameBlockGroups.values()].filter((items) => items.length > 1);
  const sameBlockPassed = multiTxBlocks.every((items) => collectSameBlockViolations(items.sort(compareChainOrder)).length === 0);

  if (executed.length === 0) {
    return [
      { item: "价格单调性", passed: true, result: "未执行", notes: "未实际发交易" },
      { item: "Supply 一致性", passed: true, result: "未执行", notes: "未实际发交易" },
      { item: "无价格操纵漏洞", passed: true, result: "未执行", notes: "未实际发交易" },
      { item: "顶部边界保护", passed: true, result: "未执行", notes: "未实际发交易" }
    ];
  }

  return [
    {
      item: "价格单调性",
      passed: Boolean(s1?.monotonicPassed) && Boolean(s2?.monotonicPassed),
      result: Boolean(s1?.monotonicPassed) && Boolean(s2?.monotonicPassed) ? "通过" : "失败",
      notes: `S1=${statusText(s1?.monotonicPassed)}; S2=${statusText(s2?.monotonicPassed)}`
    },
    {
      item: "Supply 一致性",
      passed: scenarioResults.every((item) => item.status === "not_run" || item.supplyPassed),
      result: scenarioResults.every((item) => item.status === "not_run" || item.supplyPassed) ? "通过" : "失败",
      notes: scenarioResults
        .map((item) => `${item.scenarioId}:${item.status === "not_run" ? "未执行" : item.supplyPassed ? "一致" : "不一致"}`)
        .join("; ")
    },
    {
      item: "无价格操纵漏洞",
      passed: sameBlockPassed && scenarioResults.every((item) => item.status === "not_run" || item.sameBlockPricingPassed),
      result: sameBlockPassed && scenarioResults.every((item) => item.status === "not_run" || item.sameBlockPricingPassed) ? "通过" : "失败",
      notes: `多笔同区块组数=${multiTxBlocks.length}; 同区块检查=${sameBlockPassed ? "通过" : "失败"}`
    },
    {
      item: "顶部边界保护",
      passed: s3?.status === "not_run" ? true : Boolean(s3?.boundaryPassed),
      result: s3?.status === "not_run" ? "未执行" : s3?.boundaryPassed ? "通过" : "失败",
      notes: s3?.status === "not_run" ? "未执行" : (s3?.boundaryErrorUniqueReasons || []).join(" | ")
    }
  ];
}

function writeExecutionReport() {
  mkdirSync(dirname(`${reportBase}.json`), { recursive: true });
  writeFileSync(
    `${reportBase}.json`,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        planBase,
        reportBase,
        targetTokenAddress,
        targetSymbol,
        paymentTokenAddress,
        paymentDecimals,
        targetDecimals,
        scenarioResults,
        validationResults,
        txDetails
      },
      null,
      2
    )
  );
}

function mergeExternalReports() {
  for (const path of mergeReportPaths) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        scenarioResults?: ScenarioResult[];
        txDetails?: ScenarioTx[];
      };

      for (const item of parsed.txDetails || []) {
        if (!txDetails.some((existing) => existing.hash && item.hash && existing.hash === item.hash)) {
          txDetails.push(item);
        }
      }

      for (const incoming of parsed.scenarioResults || []) {
        const index = scenarioResults.findIndex((item) => item.scenarioId === incoming.scenarioId);
        if (index === -1) {
          scenarioResults.push(incoming);
          continue;
        }

        const current = scenarioResults[index];
        if (current.status === "not_run" && incoming.status !== "not_run") {
          scenarioResults[index] = incoming;
          continue;
        }

        if (severityOfStatus(incoming.status) > severityOfStatus(current.status)) {
          scenarioResults[index] = incoming;
        }
      }
    } catch (error) {
      console.log(`Skip merge report ${path}: ${extractErrorMessage(error)}`);
    }
  }
}

function writeBackfilledWorkbook() {
  const plan = JSON.parse(readFileSync(`${planBase}.json`, "utf8")) as PlanFile;
  const scenarioById = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const validationByItem = new Map(validationResults.map((item) => [item.item, item]));

  const overviewRows = [
    ...plan.overview,
    { 字段: "最近执行时间", 内容: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
    { 字段: "执行报告", 内容: `${reportBase}.json` },
    { 字段: "总体结论", 内容: overallStatusText() }
  ];

  const caseRows = plan.scenarios.map((row) => {
    const scenario = scenarioById.get((row["场景ID"] || "") as "S1" | "S2" | "S3");
    return {
      ...row,
      执行结果: scenario ? scenarioStatusText(scenario.status) : "未执行",
      备注: scenario
        ? [
            `confirmed=${scenario.confirmedTx}`,
            `failed=${scenario.failedTx}`,
            `skipped=${scenario.skippedTx}`,
            scenario.notes.join("；")
          ]
            .filter(Boolean)
            .join(" | ")
        : "未执行"
    };
  });

  const validationRows = plan.validations.map((row) => {
    const validation = validationByItem.get(row["验证项"] || "");
    return {
      ...row,
      结果: validation?.result || "未执行",
      备注: validation?.notes || "未执行"
    };
  });

  const executionRows = scenarioResults.map((item) => ({
    场景ID: item.scenarioId,
    场景名称: item.scenarioName,
    状态: scenarioStatusText(item.status),
    开始时间: formatDateTime(item.startedAt),
    结束时间: formatDateTime(item.endedAt),
    总交易数: item.totalTx,
    成功数: item.confirmedTx,
    失败数: item.failedTx,
    跳过数: item.skippedTx,
    Supply前: formatMaybe(BigInt(item.supplyBeforeRaw || "0"), targetDecimals),
    Supply后: formatMaybe(BigInt(item.supplyAfterRaw || "0"), targetDecimals),
    Supply差值: formatMaybe(BigInt(item.supplyDeltaRaw || "0"), targetDecimals),
    Mint汇总: formatMaybe(BigInt(item.mintedSumRaw || "0"), targetDecimals),
    价格单调性: statusText(item.monotonicPassed),
    Supply一致性: statusText(item.supplyPassed),
    同区块定价: statusText(item.sameBlockPricingPassed),
    顶部边界: item.boundaryPassed === undefined ? "" : statusText(item.boundaryPassed),
    说明: item.notes.join("；")
  }));

  const detailRows = txDetails
    .slice()
    .sort(compareChainOrder)
    .map((item) => ({
      场景ID: item.scenarioId,
      场景名称: item.scenarioName,
      阶段: item.phase,
      波次: item.wave,
      钱包序号: walletIndexByAddress(item.wallet),
      钱包地址: item.wallet,
      状态: item.status,
      交易哈希: item.hash || "",
      区块号: item.blockNumber ?? "",
      交易索引: item.transactionIndex ?? "",
      Mint日志索引: item.mintLogIndex ?? "",
      买入金额: item.amountInDisplay,
      Mint数量: item.mintedDisplay || "",
      平均成交价: item.avgPrice || "",
      Gas: item.gasUsed || "",
      耗时ms: item.durationMs,
      错误: item.error || ""
    }));

  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, "测试概览", overviewRows, [{ wch: 18 }, { wch: 120 }]);
  appendSheet(
    workbook,
    "测试场景",
    caseRows,
    [{ wch: 10 }, { wch: 24 }, { wch: 34 }, { wch: 36 }, { wch: 48 }, { wch: 34 }, { wch: 8 }, { wch: 14 }, { wch: 80 }]
  );
  appendSheet(workbook, "验证点", validationRows, [{ wch: 18 }, { wch: 50 }, { wch: 28 }, { wch: 12 }, { wch: 80 }]);
  appendSheet(
    workbook,
    "执行汇总",
    executionRows,
    [{ wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 80 }]
  );
  appendSheet(
    workbook,
    "交易明细",
    detailRows,
    [{ wch: 10 }, { wch: 24 }, { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 44 }, { wch: 10 }, { wch: 68 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 16 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 80 }]
  );
  appendSheet(workbook, "取证要求", plan.evidence, [{ wch: 18 }, { wch: 120 }]);

  XLSX.writeFile(workbook, `${planBase}.xlsx`);
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>, cols: Array<{ wch: number }>) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = cols;
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function collectMonotonicViolations(items: ScenarioTx[]) {
  const violations: Array<{ previous: ScenarioTx; current: ScenarioTx }> = [];
  for (let i = 1; i < items.length; i++) {
    if (!isPriceStrictlyIncreasing(items[i - 1], items[i])) {
      violations.push({ previous: items[i - 1], current: items[i] });
    }
  }
  return violations;
}

function collectSameBlockViolations(items: ScenarioTx[]) {
  const groups = groupBy(items, (item) => `${item.blockNumber ?? "NA"}`);
  const violations: Array<{ previous: ScenarioTx; current: ScenarioTx }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort(compareChainOrder);
    violations.push(...collectMonotonicViolations(sorted));
  }
  return violations;
}

function isPriceStrictlyIncreasing(left: ScenarioTx, right: ScenarioTx) {
  const leftMint = BigInt(left.mintedRaw || "0");
  const rightMint = BigInt(right.mintedRaw || "0");
  if (leftMint <= 0n || rightMint <= 0n) return false;
  const leftAmount = BigInt(left.amountInRaw);
  const rightAmount = BigInt(right.amountInRaw);
  return leftAmount * rightMint < rightAmount * leftMint;
}

function compareChainOrder(left: ScenarioTx, right: ScenarioTx) {
  const blockDiff = (left.blockNumber ?? Number.MAX_SAFE_INTEGER) - (right.blockNumber ?? Number.MAX_SAFE_INTEGER);
  if (blockDiff !== 0) return blockDiff;
  const txDiff = (left.transactionIndex ?? Number.MAX_SAFE_INTEGER) - (right.transactionIndex ?? Number.MAX_SAFE_INTEGER);
  if (txDiff !== 0) return txDiff;
  const logDiff = (left.mintLogIndex ?? Number.MAX_SAFE_INTEGER) - (right.mintLogIndex ?? Number.MAX_SAFE_INTEGER);
  if (logDiff !== 0) return logDiff;
  return left.sequence - right.sequence;
}

function extractMintFromReceipt(logs: Array<{ address: string; topics: readonly string[]; data: string; index: number }>, wallet: string) {
  const lowerWallet = wallet.toLowerCase();
  const targetLower = targetTokenAddress.toLowerCase();
  const mint = logs.find((log) => {
    return (
      log.address.toLowerCase() === targetLower &&
      log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      topicToAddress(log.topics[1]) === ZERO_ADDRESS &&
      topicToAddress(log.topics[2]) === lowerWallet
    );
  });

  if (!mint) return null;
  return {
    amountRaw: BigInt(mint.data).toString(),
    logIndex: mint.index
  };
}

function topicToAddress(topic?: string) {
  if (!topic) return "";
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function deriveScenarioStatus(input: {
  scenarioId: "S1" | "S2" | "S3";
  monotonicPassed: boolean;
  supplyPassed: boolean;
  sameBlockPricingPassed: boolean;
  boundaryPassed?: boolean;
}) {
  if (input.scenarioId === "S3") {
    if (input.monotonicPassed && input.supplyPassed && input.sameBlockPricingPassed && input.boundaryPassed) return "passed";
    if (input.supplyPassed || input.boundaryPassed) return "partial";
    return "failed";
  }
  if (input.monotonicPassed && input.supplyPassed && input.sameBlockPricingPassed) return "passed";
  if (input.supplyPassed || input.monotonicPassed || input.sameBlockPricingPassed) return "partial";
  return "failed";
}

function notRunScenario(scenarioId: "S1" | "S2" | "S3", scenarioName: string): ScenarioResult {
  const now = new Date().toISOString();
  return {
    scenarioId,
    scenarioName,
    startedAt: now,
    endedAt: now,
    status: "not_run",
    monotonicPassed: false,
    supplyPassed: false,
    sameBlockPricingPassed: false,
    totalTx: 0,
    confirmedTx: 0,
    failedTx: 0,
    skippedTx: 0,
    notes: ["BONDING_CURVE_SKIP_EXECUTION=true，未实际发交易。"]
  };
}

function takeWallets(offset: number, count: number) {
  const start = walletStartIndex + offset;
  const selected = wallets.slice(start, start + count);
  if (selected.length < count) {
    throw new Error(`Need ${count} wallets from offset ${start}, found ${selected.length}.`);
  }
  return selected;
}

function walletIndexByAddress(address: string) {
  return wallets.find((item) => item.address.toLowerCase() === address.toLowerCase())?.index ?? -1;
}

function parseAmount(amountUsdt: string) {
  return parseUnits(amountUsdt, paymentDecimals);
}

function formatMaybe(value: bigint, decimals: number) {
  return formatUnits(value, decimals);
}

function ratioToDecimal(numerator: bigint, denominator: bigint, precision: number) {
  if (denominator === 0n) return "";
  const scale = 10n ** BigInt(precision);
  const scaled = (numerator * scale) / denominator;
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(precision, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function overallStatusText() {
  const statuses = scenarioResults.map((item) => item.status);
  if (statuses.every((item) => item === "passed")) return "全部通过";
  if (statuses.some((item) => item === "failed")) return "存在失败";
  if (statuses.some((item) => item === "partial")) return "部分通过";
  return "未执行";
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

function severityOfStatus(status: ScenarioResult["status"]) {
  const map: Record<ScenarioResult["status"], number> = {
    not_run: 0,
    failed: 1,
    partial: 2,
    passed: 3
  };
  return map[status];
}

function statusText(value?: boolean) {
  if (value === undefined) return "";
  return value ? "通过" : "失败";
}

function normalizeError(message: string) {
  return message
    .toLowerCase()
    .replace(/0x[a-f0-9]{8,}/g, "0x*")
    .replace(/\s+/g, " ")
    .trim();
}

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const anyError = error as Error & {
      shortMessage?: string;
      info?: { error?: { message?: string }; responseBody?: string };
      reason?: string;
    };
    return anyError.shortMessage || anyError.reason || anyError.info?.error?.message || anyError.info?.responseBody || anyError.message;
  }
  return String(error);
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function groupBy<T>(items: T[], key: (item: T) => string) {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const groupKey = key(item);
    const bucket = map.get(groupKey) || [];
    bucket.push(item);
    map.set(groupKey, bucket);
  }
  return map;
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const results: T[] = [];
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      results[taskIndex] = await tasks[taskIndex]();
    }
  });

  await Promise.all(workers);
  return results;
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

async function withRetry<T>(fn: () => Promise<T>, retries = providerRetries) {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryableRpcError(error)) {
        throw error;
      }
      await sleep(providerRetryDelayMs * (attempt + 1));
      attempt += 1;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableRpcError(error: unknown) {
  const message = extractErrorMessage(error).toLowerCase();
  return (
    message.includes("too many requests") ||
    message.includes("429") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("exceeded maximum retry limit") ||
    message.includes("network error") ||
    message.includes("server error")
  );
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

function numberEnvAllowZero(name: string, fallback: number) {
  return numberEnv(name, fallback);
}

function boolEnv(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw.toLowerCase() === "true";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

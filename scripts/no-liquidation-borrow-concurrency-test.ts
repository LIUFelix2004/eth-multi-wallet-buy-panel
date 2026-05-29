import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, MaxUint256, Wallet, formatUnits } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

type WalletEntry = {
  index: number;
  address: string;
  privateKey: string;
};

type PositionState = {
  collateralAmount: bigint;
  debtAmount: bigint;
};

type BorrowPoolState = {
  totalCollateral: bigint;
  totalDebt: bigint;
  cashReserve: bigint;
  disableBorrow: boolean;
};

type MarketState = {
  totalSupply: bigint;
  reserve: bigint;
  currentPrice: bigint;
  athPrice: bigint;
  floorPrice: bigint;
};

type ScenarioId = "B1" | "B2" | "B3";

type ScenarioTx = {
  scenarioId: ScenarioId;
  scenarioName: string;
  action: "borrow" | "sell" | "buy" | "loop";
  sequence: number;
  walletIndex: number;
  wallet: string;
  status: "confirmed" | "failed" | "skipped";
  hash?: string;
  blockNumber?: number;
  transactionIndex?: number;
  gasUsed?: string;
  durationMs: number;
  collateralAmountRaw?: string;
  requestedDebtRaw?: string;
  quotedAmountOutRaw?: string;
  quotedMaxDebtRaw?: string;
  actualAmountOutRaw?: string;
  floorPriceRaw?: string;
  theoreticalLimitRaw?: string;
  error?: string;
};

type ScenarioResult = {
  scenarioId: ScenarioId;
  scenarioName: string;
  startedAt: string;
  endedAt: string;
  status: "passed" | "failed" | "partial" | "not_run";
  metricMethod: string;
  floorPriceBeforeRaw?: string;
  floorPriceAfterRaw?: string;
  totalDebtBeforeRaw?: string;
  totalDebtAfterRaw?: string;
  cashReserveBeforeRaw?: string;
  cashReserveAfterRaw?: string;
  limitPassed?: boolean;
  noLiquidationPassed?: boolean;
  loopPassed?: boolean;
  reserveLimitPassed?: boolean;
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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  npm run no-liquidation-borrow-test

Core env:
  RPC_URL
  BUY_CONTRACT_ADDRESS
  PAYMENT_TOKEN_ADDRESS
  PRIVATE_KEYS
  REFERRAL_TARGET_TOKEN_ADDRESS

Optional env:
  NO_LIQ_BORROW_PLAN_BASE                 default reports/无清算借贷并发测试
  NO_LIQ_BORROW_REPORT_BASE               default reports/no-liquidation-borrow-<timestamp>
  NO_LIQ_BORROW_SKIP_EXECUTION            true to only validate config and rewrite workbook
  NO_LIQ_BORROW_SKIP_APPROVALS            default false
  NO_LIQ_BORROW_SKIP_WALLET_SCAN          default false
  NO_LIQ_BORROW_PROVIDER_RETRIES          default 6
  NO_LIQ_BORROW_PROVIDER_RETRY_DELAY_MS   default 1200
  NO_LIQ_BORROW_WALLET_SCAN_DELAY_MS      default 250

Scenario B1:
  NLB_B1_WALLETS                          default 100
  NLB_B1_COLLATERAL_BPS                   default 3000
  NLB_B1_CONCURRENCY                      default 20

Scenario B2:
  NLB_B2_BORROW_WALLETS                   default 10
  NLB_B2_SELL_WALLETS                     default 10
  NLB_B2_CONCURRENCY                      default 5
  NLB_B2_SELL_AMOUNT_TOKEN                optional fixed sell amount

Scenario B3:
  NLB_B3_WALLETS                          default 20
  NLB_B3_LOOP_ROUNDS                      default 2
  NLB_B3_FIRST_BUY_USDT                   default 1000
  NLB_B3_CONCURRENCY                      default 5
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
const planBase = process.env.NO_LIQ_BORROW_PLAN_BASE || "reports/无清算借贷并发测试";
const reportBase = process.env.NO_LIQ_BORROW_REPORT_BASE || `reports/no-liquidation-borrow-${runId}`;
const skipExecution = boolEnv("NO_LIQ_BORROW_SKIP_EXECUTION", false);
const skipApprovals = boolEnv("NO_LIQ_BORROW_SKIP_APPROVALS", false);
const skipWalletScan = boolEnv("NO_LIQ_BORROW_SKIP_WALLET_SCAN", false);
const providerRetries = numberEnv("NO_LIQ_BORROW_PROVIDER_RETRIES", 6);
const providerRetryDelayMs = numberEnv("NO_LIQ_BORROW_PROVIDER_RETRY_DELAY_MS", 1200);
const walletScanDelayMs = numberEnv("NO_LIQ_BORROW_WALLET_SCAN_DELAY_MS", 250);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");

const b1 = {
  wallets: numberEnv("NLB_B1_WALLETS", 100),
  collateralBps: numberEnv("NLB_B1_COLLATERAL_BPS", 3000),
  concurrency: numberEnv("NLB_B1_CONCURRENCY", 20)
};

const b2 = {
  borrowWallets: numberEnv("NLB_B2_BORROW_WALLETS", 10),
  sellWallets: numberEnv("NLB_B2_SELL_WALLETS", 10),
  concurrency: numberEnv("NLB_B2_CONCURRENCY", 5),
  sellAmountToken: process.env.NLB_B2_SELL_AMOUNT_TOKEN || "100000"
};

const b3 = {
  wallets: numberEnv("NLB_B3_WALLETS", 20),
  rounds: numberEnv("NLB_B3_LOOP_ROUNDS", 2),
  firstBuyUsdt: process.env.NLB_B3_FIRST_BUY_USDT || "1000",
  concurrency: numberEnv("NLB_B3_CONCURRENCY", 5)
};

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
const abi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 tokensIn,uint256 minAmountOut,uint256 deadline)",
  "function depositAndBorrow(address token,uint256 depositAmount,uint256 debtAmount) returns (uint256 amountOut)",
  "function quoteBorrow(address token,address user,uint256 debtAmount) view returns (uint256 amountOut,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee,uint256 maxDebt,uint256 cashReserve)",
  "function borrowInfo(address token) view returns ((uint256 totalCollateral,uint256 totalDebt,uint256 cashReserve,bool disableBorrow))",
  "function positionOf(address token,address user) view returns ((uint256 collateralAmount,uint256 debtAmount))",
  "function marketState(address token) view returns ((uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice))",
  "function marketInfo(address token) view returns ((address token,address reserveToken,address creator,uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice,uint256 marketLiquidity,uint256 sellMarketDepth,uint256 sellMarketSlope,uint256 buyTargetPrice,uint256 derivedB2,uint256 creatorShare,uint256 reserveShare,bool disableSell))"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const eventAbi = [
  "event Borrowed(address indexed token,address indexed user,uint256 debtAdded,uint256 amountOut,uint256 floorPrice,uint256 collateralAmount)",
  "event Sell(address indexed token,address indexed seller,uint256 tokensIn,uint256 grossOut,uint256 amountOut,uint256 finalPrice,uint256 floorPrice)",
  "event Buy(address indexed token,address indexed buyer,uint256 amountIn,uint256 netInForCurve,uint256 tokensOut,uint256 finalPrice,uint256 floorPrice)"
];

const market = new Contract(marketAddress, abi, provider);
const reserveToken = new Contract(reserveTokenAddress, erc20Abi, provider);
const targetToken = new Contract(targetTokenAddress, erc20Abi, provider);
const eventIface = new Interface(eventAbi);
const borrowedTopic = eventIface.getEvent("Borrowed").topicHash.toLowerCase();
const sellTopic = eventIface.getEvent("Sell").topicHash.toLowerCase();
const buyTopic = eventIface.getEvent("Buy").topicHash.toLowerCase();

const [reserveDecimalsRaw, targetDecimalsRaw, marketInfo] = await Promise.all([
  withRetry(() => reserveToken.decimals()),
  withRetry(() => targetToken.decimals()),
  withRetry(() => market.marketInfo(targetTokenAddress))
]);
const reserveDecimals = Number(reserveDecimalsRaw);
const targetDecimals = Number(targetDecimalsRaw);

const wallets: WalletEntry[] = privateKeys.map((privateKey, index) => ({
  index,
  address: new Wallet(privateKey).address,
  privateKey
}));

const txDetails: ScenarioTx[] = [];
const scenarioResults: ScenarioResult[] = [];
const validationResults: ValidationResult[] = [];

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${marketAddress}`);
console.log(`Reserve token: ${reserveTokenAddress}`);
console.log(`Target token: ${targetTokenAddress}`);
console.log(`Wallets loaded: ${wallets.length}`);
console.log(`Plan base: ${planBase}`);
console.log(`Report base: ${reportBase}`);
console.log(`Skip execution: ${skipExecution}`);

if (!skipExecution) {
  const walletStates = await loadWalletStates();
  await prepareApprovals(walletStates);

  scenarioResults.push(await runB1(walletStates));
  scenarioResults.push(await runB2(walletStates));
  scenarioResults.push(await runB3(walletStates));
} else {
  scenarioResults.push(notRun("B1", "100个钱包同时发起借贷（按地板价计算额度）"));
  scenarioResults.push(notRun("B2", "借贷 + 同时 Sell（市场价波动）"));
  scenarioResults.push(notRun("B3", "Looping 循环借贷并发"));
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

  const rows: Array<WalletEntry & { ethBalance: bigint; tokenBalance: bigint; reserveBalance: bigint }> = [];
  for (const wallet of wallets) {
    const ethBalance = await withRetry(() => provider.getBalance(wallet.address));
    const tokenBalance = await withRetry(() => targetToken.balanceOf(wallet.address));
    const reserveBalance = await withRetry(() => reserveToken.balanceOf(wallet.address));
    rows.push({ ...wallet, ethBalance, tokenBalance, reserveBalance });
    if (walletScanDelayMs > 0) await sleep(walletScanDelayMs);
  }
  return rows;
}

async function prepareApprovals(walletStates: Array<WalletEntry & { tokenBalance: bigint; reserveBalance: bigint }>) {
  if (skipApprovals) return;
  const tasks = walletStates.map((state) => async () => {
    const wallet = new Wallet(state.privateKey, provider);
    const connectedTarget = new Contract(targetTokenAddress, erc20Abi, wallet);
    const connectedReserve = new Contract(reserveTokenAddress, erc20Abi, wallet);
    if (state.tokenBalance > 0n) {
      const allowance = await withRetry(() => connectedTarget.allowance(wallet.address, marketAddress));
      if (allowance < state.tokenBalance) {
        const tx = await withRetry(() => connectedTarget.approve(marketAddress, MaxUint256));
        await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
      }
    }
    if (state.reserveBalance > 0n) {
      const allowance = await withRetry(() => connectedReserve.allowance(wallet.address, marketAddress));
      if (allowance < state.reserveBalance) {
        const tx = await withRetry(() => connectedReserve.approve(marketAddress, MaxUint256));
        await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
      }
    }
  });
  await runWithConcurrency(tasks, 1);
}

async function runB1(walletStates: Array<WalletEntry & { ethBalance: bigint; tokenBalance: bigint }>) {
  const scenarioId: "B1" = "B1";
  const scenarioName = "100个钱包同时发起借贷（按地板价计算额度）";
  const selected = takeWallets(walletStates, b1.wallets);
  const poolBefore = await getBorrowPoolState();
  const marketBefore = await getMarketState();
  const startedAt = new Date().toISOString();

  const tasks = selected.map((state, sequence) => async () => {
    const collateralAmount = skipWalletScan ? 300000n * 10n ** BigInt(targetDecimals) : (state.tokenBalance * BigInt(b1.collateralBps)) / 10_000n;
    return executeBorrowTx(scenarioId, scenarioName, sequence, state, collateralAmount);
  });
  const results = await runWithConcurrency(tasks, Math.min(b1.concurrency, tasks.length || 1));
  txDetails.push(...results);

  const poolAfter = await getBorrowPoolState();
  const marketAfter = await getMarketState();
  const confirmed = results.filter((item) => item.status === "confirmed");
  const skipped = results.filter((item) => item.status === "skipped");
  const failed = results.filter((item) => item.status === "failed");
  const limitPassed = confirmed.every((item) => {
    const theoretical = BigInt(item.theoreticalLimitRaw || "0");
    const actual = BigInt(item.actualAmountOutRaw || "0");
    return actual <= theoretical;
  });
  const reserveLimitPassed = poolAfter.totalDebt <= poolBefore.cashReserve + poolBefore.totalDebt;
  const hasEffectiveSamples = confirmed.length > 0;
  const notes: string[] = [];
  if (!hasEffectiveSamples) {
    notes.push("无有效借贷成交样本。");
  }
  const zeroDebtSkips = skipped.filter((item) => (item.quotedMaxDebtRaw || "0") === "0").length;
  if (zeroDebtSkips > 0) {
    notes.push(`quoteBorrow.maxDebt=0 的跳过样本 ${zeroDebtSkips} 笔。`);
  }

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt: new Date().toISOString(),
    status: hasEffectiveSamples ? (limitPassed && reserveLimitPassed ? "passed" : limitPassed || reserveLimitPassed ? "partial" : "failed") : "failed",
    metricMethod: "marketState.floorPrice + quoteBorrow + Borrowed event",
    floorPriceBeforeRaw: marketBefore.floorPrice.toString(),
    floorPriceAfterRaw: marketAfter.floorPrice.toString(),
    totalDebtBeforeRaw: poolBefore.totalDebt.toString(),
    totalDebtAfterRaw: poolAfter.totalDebt.toString(),
    cashReserveBeforeRaw: poolBefore.cashReserve.toString(),
    cashReserveAfterRaw: poolAfter.cashReserve.toString(),
    limitPassed,
    reserveLimitPassed,
    totalTx: results.length,
    confirmedTx: confirmed.length,
    failedTx: failed.length,
    skippedTx: skipped.length,
    notes
  };
}

async function runB2(walletStates: Array<WalletEntry & { ethBalance: bigint; tokenBalance: bigint }>) {
  const scenarioId: "B2" = "B2";
  const scenarioName = "借贷 + 同时 Sell（市场价波动）";
  const borrowers = takeWallets(walletStates, b2.borrowWallets);
  const sellers = takeWallets(walletStates.slice(b2.borrowWallets), b2.sellWallets);
  const poolBefore = await getBorrowPoolState();
  const marketBefore = await getMarketState();
  const borrowerPositionsBefore = await Promise.all(borrowers.map((wallet) => getPosition(wallet.address)));
  const startedAt = new Date().toISOString();

  let sequence = 0;
  const tasks = [
    ...borrowers.map((state) => async () => {
      const collateralAmount = skipWalletScan ? 300000n * 10n ** BigInt(targetDecimals) : (state.tokenBalance * 2000n) / 10_000n;
      return executeBorrowTx(scenarioId, scenarioName, sequence++, state, collateralAmount);
    }),
    ...sellers.map((state) => async () => {
      const amount = process.env.NLB_B2_SELL_AMOUNT_TOKEN
        ? BigInt(process.env.NLB_B2_SELL_AMOUNT_TOKEN) * 10n ** BigInt(targetDecimals)
        : skipWalletScan
          ? 100000n * 10n ** BigInt(targetDecimals)
          : (state.tokenBalance * 1000n) / 10_000n;
      return executeSellTx(scenarioId, scenarioName, sequence++, state, amount);
    })
  ];
  const results = await runWithConcurrency(tasks, Math.min(b2.concurrency, tasks.length || 1));
  txDetails.push(...results);

  const borrowerPositionsAfter = await Promise.all(borrowers.map((wallet) => getPosition(wallet.address)));
  const marketAfter = await getMarketState();
  const noLiquidationPassed = borrowerPositionsAfter.every((pos, i) => pos.debtAmount >= borrowerPositionsBefore[i].debtAmount);
  const confirmed = results.filter((item) => item.status === "confirmed");
  const failed = results.filter((item) => item.status === "failed");
  const skipped = results.filter((item) => item.status === "skipped");
  const hasBorrowOrSellSamples = confirmed.length > 0;
  const notes: string[] = [];
  if (!hasBorrowOrSellSamples) notes.push("无有效借贷/卖出成交样本。");

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt: new Date().toISOString(),
    status: hasBorrowOrSellSamples ? (noLiquidationPassed ? "passed" : "failed") : "failed",
    metricMethod: "positionOf + marketState",
    floorPriceBeforeRaw: marketBefore.floorPrice.toString(),
    floorPriceAfterRaw: marketAfter.floorPrice.toString(),
    totalDebtBeforeRaw: poolBefore.totalDebt.toString(),
    totalDebtAfterRaw: (await getBorrowPoolState()).totalDebt.toString(),
    cashReserveBeforeRaw: poolBefore.cashReserve.toString(),
    cashReserveAfterRaw: (await getBorrowPoolState()).cashReserve.toString(),
    noLiquidationPassed,
    totalTx: results.length,
    confirmedTx: confirmed.length,
    failedTx: failed.length,
    skippedTx: skipped.length,
    notes
  };
}

async function runB3(walletStates: Array<WalletEntry & { ethBalance: bigint; tokenBalance: bigint; reserveBalance: bigint }>) {
  const scenarioId: "B3" = "B3";
  const scenarioName = "Looping 循环借贷并发";
  const selected = takeWallets(walletStates, b3.wallets);
  const poolBefore = await getBorrowPoolState();
  const marketBefore = await getMarketState();
  const startedAt = new Date().toISOString();

  const tasks = selected.map((state, sequence) => async () => executeLoopTx(scenarioId, scenarioName, sequence, state));
  const results = await runWithConcurrency(tasks, Math.min(b3.concurrency, tasks.length || 1));
  txDetails.push(...results);
  const poolAfter = await getBorrowPoolState();
  const marketAfter = await getMarketState();
  const reserveLimitPassed = poolAfter.totalDebt <= poolBefore.cashReserve + poolBefore.totalDebt;
  const confirmed = results.filter((item) => item.status === "confirmed");
  const failed = results.filter((item) => item.status === "failed");
  const skipped = results.filter((item) => item.status === "skipped");
  const loopPassed = confirmed.length > 0 && failed.every((item) => Boolean(item.error));
  const notes: string[] = [];
  if (confirmed.length === 0) notes.push("无成功 loop 样本。");

  return {
    scenarioId,
    scenarioName,
    startedAt,
    endedAt: new Date().toISOString(),
    status: confirmed.length > 0 ? (loopPassed && reserveLimitPassed ? "passed" : loopPassed || reserveLimitPassed ? "partial" : "failed") : "failed",
    metricMethod: "depositAndBorrow + buy + quoteBorrow",
    floorPriceBeforeRaw: marketBefore.floorPrice.toString(),
    floorPriceAfterRaw: marketAfter.floorPrice.toString(),
    totalDebtBeforeRaw: poolBefore.totalDebt.toString(),
    totalDebtAfterRaw: poolAfter.totalDebt.toString(),
    cashReserveBeforeRaw: poolBefore.cashReserve.toString(),
    cashReserveAfterRaw: poolAfter.cashReserve.toString(),
    loopPassed,
    reserveLimitPassed,
    totalTx: results.length,
    confirmedTx: confirmed.length,
    failedTx: failed.length,
    skippedTx: skipped.length,
    notes
  };
}

async function executeBorrowTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  sequence: number,
  state: WalletEntry & { ethBalance?: bigint; tokenBalance?: bigint },
  collateralAmount: bigint
): Promise<ScenarioTx> {
  const startedAt = Date.now();
  if (collateralAmount <= 0n) {
    return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, { status: "skipped", error: "No collateral amount" });
  }
  if (!skipWalletScan && state.ethBalance !== undefined && state.ethBalance < minEthWei) {
    return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, { status: "skipped", error: `Insufficient ETH for gas: ${state.ethBalance.toString()}` });
  }

  try {
    const marketState = await withRetry(() => market.marketState(targetTokenAddress));
    const theoreticalLimit = (collateralAmount * (marketState.floorPrice as bigint)) / 10n ** BigInt(targetDecimals);
    const quote = await withRetry(() => market.quoteBorrow(targetTokenAddress, state.address, theoreticalLimit));
    let debtAmount = quote.maxDebt < theoreticalLimit ? quote.maxDebt : theoreticalLimit;
    let quotedAmountOut = quote.amountOut as bigint;
    let quotedMaxDebt = quote.maxDebt as bigint;
    if (debtAmount <= 0n) {
      try {
        const wallet = new Wallet(state.privateKey, provider);
        const connected = new Contract(marketAddress, abi, wallet);
        const simulated = await withRetry(() => connected.depositAndBorrow.staticCall(targetTokenAddress, collateralAmount, theoreticalLimit));
        debtAmount = theoreticalLimit;
        quotedAmountOut = simulated as bigint;
      } catch {
        // Keep debtAmount as 0 and fall through to skipped result below.
      }
    }
    if (debtAmount <= 0n) {
      return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, {
        status: "skipped",
        collateralAmountRaw: collateralAmount.toString(),
        theoreticalLimitRaw: theoreticalLimit.toString(),
        quotedMaxDebtRaw: quotedMaxDebt.toString(),
        quotedAmountOutRaw: quotedAmountOut.toString(),
        error: quote.maxDebt <= 0n ? "quoteBorrow.maxDebt=0 and depositAndBorrow.staticCall failed" : "No borrowable amount"
      });
    }

    const wallet = new Wallet(state.privateKey, provider);
    const connected = new Contract(marketAddress, abi, wallet);
    const tx = await withRetry(() => connected.depositAndBorrow(targetTokenAddress, collateralAmount, debtAmount));
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, {
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        transactionIndex: receipt?.index,
        gasUsed: receipt?.gasUsed?.toString(),
        collateralAmountRaw: collateralAmount.toString(),
        requestedDebtRaw: debtAmount.toString(),
        quotedAmountOutRaw: quotedAmountOut.toString(),
        quotedMaxDebtRaw: quotedMaxDebt.toString(),
        floorPriceRaw: (marketState.floorPrice as bigint).toString(),
        theoreticalLimitRaw: theoreticalLimit.toString(),
        error: `tx reverted: ${tx.hash}`
      });
    }
    const borrowed = receipt.logs
      .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === borrowedTopic)
      .map((log) => eventIface.parseLog({ topics: [...log.topics], data: log.data }))[0];
    return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      collateralAmountRaw: collateralAmount.toString(),
      requestedDebtRaw: debtAmount.toString(),
      quotedAmountOutRaw: quotedAmountOut.toString(),
      quotedMaxDebtRaw: quotedMaxDebt.toString(),
      actualAmountOutRaw: (borrowed?.args[3] as bigint | undefined)?.toString(),
      floorPriceRaw: ((borrowed?.args[4] as bigint | undefined) || marketState.floorPrice).toString(),
      theoreticalLimitRaw: theoreticalLimit.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "borrow", sequence, state, startedAt, {
      status: "failed",
      collateralAmountRaw: collateralAmount.toString(),
      error: extractErrorMessage(error)
    });
  }
}

async function executeSellTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  sequence: number,
  state: WalletEntry & { tokenBalance?: bigint },
  amountRaw: bigint
): Promise<ScenarioTx> {
  const startedAt = Date.now();
  try {
    const wallet = new Wallet(state.privateKey, provider);
    const connected = new Contract(marketAddress, abi, wallet);
    const tx = await withRetry(() => connected.sell(targetTokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds));
    const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return baseTx(scenarioId, scenarioName, "sell", sequence, state, startedAt, { status: "failed", hash: tx.hash, error: `tx reverted: ${tx.hash}` });
    }
    const parsed = receipt.logs
      .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === sellTopic)
      .map((log) => eventIface.parseLog({ topics: [...log.topics], data: log.data }))[0];
    return baseTx(scenarioId, scenarioName, "sell", sequence, state, startedAt, {
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      actualAmountOutRaw: (parsed?.args[4] as bigint | undefined)?.toString(),
      floorPriceRaw: (parsed?.args[6] as bigint | undefined)?.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "sell", sequence, state, startedAt, { status: "failed", error: extractErrorMessage(error) });
  }
}

async function executeLoopTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  sequence: number,
  state: WalletEntry & { reserveBalance?: bigint; tokenBalance?: bigint }
): Promise<ScenarioTx> {
  const startedAt = Date.now();
  try {
    const wallet = new Wallet(state.privateKey, provider);
    const connected = new Contract(marketAddress, abi, wallet);
    let buyAmount = BigInt(0);
    let collateralAmount = state.tokenBalance && state.tokenBalance > 0n ? state.tokenBalance / 4n : 300000n * 10n ** BigInt(targetDecimals);
    let debtRequested = 0n;
    let lastFloor = 0n;

    for (let i = 0; i < b3.rounds; i++) {
      if (i === 0) {
        buyAmount = BigInt(Math.trunc(Number(b3.firstBuyUsdt))) * 10n ** BigInt(reserveDecimals);
        const buyTx = await withRetry(() => connected.buy(targetTokenAddress, buyAmount, 0, Math.floor(Date.now() / 1000) + deadlineSeconds));
        const buyReceipt = await waitWithTimeout(withRetry(() => buyTx.wait()), receiptTimeoutMs);
        if (buyReceipt?.status !== 1) throw new Error(`Loop buy failed: ${buyTx.hash}`);
        const parsedBuy = buyReceipt.logs
          .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === buyTopic)
          .map((log) => eventIface.parseLog({ topics: [...log.topics], data: log.data }))[0];
        lastFloor = (parsedBuy?.args[6] as bigint | undefined) || 0n;
      }

      const marketState = await withRetry(() => market.marketState(targetTokenAddress));
      const theoretical = (collateralAmount * (marketState.floorPrice as bigint)) / 10n ** BigInt(targetDecimals);
      const quote = await withRetry(() => market.quoteBorrow(targetTokenAddress, state.address, theoretical));
      debtRequested = quote.maxDebt < theoretical ? quote.maxDebt : theoretical;
      if (debtRequested <= 0n) {
        try {
          const simulated = await withRetry(() => connected.depositAndBorrow.staticCall(targetTokenAddress, collateralAmount, theoretical));
          if ((simulated as bigint) > 0n) {
            debtRequested = theoretical;
          }
        } catch {
          throw new Error("Loop max debt is 0");
        }
      }

      const tx = await withRetry(() => connected.depositAndBorrow(targetTokenAddress, collateralAmount, debtRequested));
      const receipt = await waitWithTimeout(withRetry(() => tx.wait()), receiptTimeoutMs);
      if (receipt?.status !== 1) throw new Error(`Loop borrow failed: ${tx.hash}`);
      const parsedBorrow = receipt.logs
        .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === borrowedTopic)
        .map((log) => eventIface.parseLog({ topics: [...log.topics], data: log.data }))[0];
      lastFloor = (parsedBorrow?.args[4] as bigint | undefined) || (marketState.floorPrice as bigint);
      collateralAmount += ((parsedBorrow?.args[3] as bigint | undefined) || 0n) / 2n;
    }

    return baseTx(scenarioId, scenarioName, "loop", sequence, state, startedAt, {
      status: "confirmed",
      collateralAmountRaw: collateralAmount.toString(),
      requestedDebtRaw: debtRequested.toString(),
      floorPriceRaw: lastFloor.toString()
    });
  } catch (error) {
    return baseTx(scenarioId, scenarioName, "loop", sequence, state, startedAt, {
      status: "failed",
      error: extractErrorMessage(error)
    });
  }
}

async function getBorrowPoolState(): Promise<BorrowPoolState> {
  const v = await withRetry(() => market.borrowInfo(targetTokenAddress));
  return {
    totalCollateral: v.totalCollateral as bigint,
    totalDebt: v.totalDebt as bigint,
    cashReserve: v.cashReserve as bigint,
    disableBorrow: v.disableBorrow as boolean
  };
}

async function getMarketState(): Promise<MarketState> {
  const v = await withRetry(() => market.marketState(targetTokenAddress));
  return {
    totalSupply: v.totalSupply as bigint,
    reserve: v.reserve as bigint,
    currentPrice: v.currentPrice as bigint,
    athPrice: v.athPrice as bigint,
    floorPrice: v.floorPrice as bigint
  };
}

async function getPosition(address: string): Promise<PositionState> {
  const v = await withRetry(() => market.positionOf(targetTokenAddress, address));
  return {
    collateralAmount: v.collateralAmount as bigint,
    debtAmount: v.debtAmount as bigint
  };
}

function takeWallets<T>(items: T[], count: number) {
  return items.slice(0, Math.min(count, items.length));
}

function baseTx(
  scenarioId: ScenarioId,
  scenarioName: string,
  action: ScenarioTx["action"],
  sequence: number,
  state: WalletEntry,
  startedAt: number,
  patch: Partial<ScenarioTx>
): ScenarioTx {
  return {
    scenarioId,
    scenarioName,
    action,
    sequence,
    walletIndex: state.index,
    wallet: state.address,
    status: patch.status || "failed",
    durationMs: Date.now() - startedAt,
    ...patch
  };
}

function buildValidationResults() {
  const byId = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const b1Result = byId.get("B1");
  const b2Result = byId.get("B2");
  const b3Result = byId.get("B3");
  return [
    {
      item: "借贷额度计算正确",
      result: b1Result?.limitPassed ? "通过" : b1Result?.status === "not_run" ? "未执行" : "失败",
      notes: `B1=${boolText(b1Result?.limitPassed)}`
    },
    {
      item: "无清算",
      result: b2Result?.noLiquidationPassed ? "通过" : b2Result?.status === "not_run" ? "未执行" : "失败",
      notes: `B2=${boolText(b2Result?.noLiquidationPassed)}`
    },
    {
      item: "Looping 上限行为正确",
      result: b3Result?.loopPassed ? "通过" : b3Result?.status === "not_run" ? "未执行" : "失败",
      notes: `B3=${boolText(b3Result?.loopPassed)}`
    },
    {
      item: "总借出量不超额",
      result: b1Result?.reserveLimitPassed && b3Result?.reserveLimitPassed ? "通过" : "失败",
      notes: `B1=${boolText(b1Result?.reserveLimitPassed)}; B3=${boolText(b3Result?.reserveLimitPassed)}`
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
        reserveDecimals,
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

function writeWorkbook() {
  const plan = JSON.parse(readFileSync(`${planBase}.json`, "utf8")) as PlanFile;
  const byId = new Map(scenarioResults.map((item) => [item.scenarioId, item]));
  const byValidation = new Map(validationResults.map((item) => [item.item, item]));

  const overviewRows = [
    ...plan.overview,
    { 字段: "最近执行时间", 内容: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
    { 字段: "执行报告", 内容: `${reportBase}.json` },
    { 字段: "买入目标", 内容: targetTokenAddress }
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
    Floor前: item.floorPriceBeforeRaw ? formatUnits(BigInt(item.floorPriceBeforeRaw), reserveDecimals) : "",
    Floor后: item.floorPriceAfterRaw ? formatUnits(BigInt(item.floorPriceAfterRaw), reserveDecimals) : "",
    TotalDebt前: item.totalDebtBeforeRaw ? formatUnits(BigInt(item.totalDebtBeforeRaw), reserveDecimals) : "",
    TotalDebt后: item.totalDebtAfterRaw ? formatUnits(BigInt(item.totalDebtAfterRaw), reserveDecimals) : "",
    CashReserve前: item.cashReserveBeforeRaw ? formatUnits(BigInt(item.cashReserveBeforeRaw), reserveDecimals) : "",
    CashReserve后: item.cashReserveAfterRaw ? formatUnits(BigInt(item.cashReserveAfterRaw), reserveDecimals) : "",
    额度正确: item.limitPassed === undefined ? "" : boolText(item.limitPassed),
    无清算: item.noLiquidationPassed === undefined ? "" : boolText(item.noLiquidationPassed),
    Loop稳定: item.loopPassed === undefined ? "" : boolText(item.loopPassed),
    储备上限: item.reserveLimitPassed === undefined ? "" : boolText(item.reserveLimitPassed),
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
    Collateral: item.collateralAmountRaw ? formatUnits(BigInt(item.collateralAmountRaw), targetDecimals) : "",
    理论额度: item.theoreticalLimitRaw ? formatUnits(BigInt(item.theoreticalLimitRaw), reserveDecimals) : "",
    请求Debt: item.requestedDebtRaw ? formatUnits(BigInt(item.requestedDebtRaw), reserveDecimals) : "",
    实际借出: item.actualAmountOutRaw ? formatUnits(BigInt(item.actualAmountOutRaw), reserveDecimals) : "",
    FloorPrice: item.floorPriceRaw ? formatUnits(BigInt(item.floorPriceRaw), reserveDecimals) : "",
    Gas: item.gasUsed || "",
    耗时ms: item.durationMs,
    错误: item.error || ""
  }));

  const workbook = XLSX.utils.book_new();
  appendSheet(workbook, "测试概览", overviewRows, [{ wch: 18 }, { wch: 120 }]);
  appendSheet(workbook, "测试场景", caseRows, [{ wch: 10 }, { wch: 30 }, { wch: 38 }, { wch: 44 }, { wch: 54 }, { wch: 40 }, { wch: 8 }, { wch: 14 }, { wch: 84 }]);
  appendSheet(workbook, "验证点", validationRows, [{ wch: 22 }, { wch: 58 }, { wch: 36 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "执行汇总", executionRows, [{ wch: 10 }, { wch: 30 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 84 }]);
  appendSheet(workbook, "交易明细", detailRows, [{ wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 44 }, { wch: 10 }, { wch: 68 }, { wch: 12 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 10 }, { wch: 84 }]);
  appendSheet(workbook, "取证要求", plan.evidence, [{ wch: 18 }, { wch: 128 }]);

  XLSX.writeFile(workbook, `${planBase}.xlsx`);
}

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Record<string, unknown>>, cols: Array<{ wch: number }>) {
  const sheet = XLSX.utils.json_to_sheet(rows);
  sheet["!cols"] = cols;
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

function notRun(scenarioId: ScenarioId, scenarioName: string): ScenarioResult {
  const now = new Date().toISOString();
  return {
    scenarioId,
    scenarioName,
    startedAt: now,
    endedAt: now,
    status: "not_run",
    metricMethod: "",
    totalTx: 0,
    confirmedTx: 0,
    failedTx: 0,
    skippedTx: 0,
    notes: ["NO_LIQ_BORROW_SKIP_EXECUTION=true，未实际发交易。"],
    limitPassed: false,
    noLiquidationPassed: false,
    loopPassed: false,
    reserveLimitPassed: false
  };
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

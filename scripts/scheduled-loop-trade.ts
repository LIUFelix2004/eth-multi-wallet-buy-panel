import "dotenv/config";
import { Contract, JsonRpcProvider, parseUnits, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type LoopResult = {
  round: number;
  index: number;
  wallet: string;
  action?: "buy-borrow" | "sell";
  status: "confirmed" | "failed" | "skipped";
  firstBuyAmount?: string;
  borrowAmount?: string;
  collateralAmount?: string;
  postBorrowAction?: "buy" | "sell";
  postBorrowAmount?: string;
  firstBuyHash?: string;
  borrowHash?: string;
  postBorrowHash?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const marketContractAddress = requiredEnv("LOOP_MARKET_CONTRACT");
const tokenAddress = requiredEnv("LOOP_TOKEN_ADDRESS");
const reserveTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const walletsPerRound = numberEnv("LOOP_WALLETS_PER_ROUND", 100);
const activeWalletsMin = numberEnv("LOOP_ACTIVE_WALLETS_MIN", walletsPerRound);
const activeWalletsMax = numberEnv("LOOP_ACTIVE_WALLETS_MAX", walletsPerRound);
const rounds = numberEnv("LOOP_ROUNDS", 30);
const intervalMs = numberEnv("LOOP_INTERVAL_MS", 60_000);
const maxConcurrency = numberEnv("LOOP_MAX_CONCURRENCY", 5);
const actionMode = process.env.LOOP_ACTION_MODE || "buy-borrow-sell";
const buyBorrowProbabilityBps = numberEnv("LOOP_BUY_BORROW_PROBABILITY_BPS", 5000);
const firstBuyMin = BigInt(requiredEnv("LOOP_FIRST_BUY_MIN"));
const firstBuyMax = BigInt(requiredEnv("LOOP_FIRST_BUY_MAX"));
const postBorrowAction = actionEnv("LOOP_POST_BORROW_ACTION", "buy");
const postBorrowMin = BigInt(process.env.LOOP_POST_BORROW_MIN || process.env.LOOP_SECOND_BUY_MIN || "0");
const postBorrowMax = BigInt(process.env.LOOP_POST_BORROW_MAX || process.env.LOOP_SECOND_BUY_MAX || "0");
const sellAmountMode = process.env.LOOP_SELL_AMOUNT_MODE || "fixed-range";
const collateralBps = BigInt(numberEnv("LOOP_COLLATERAL_BPS", 9000));
const borrowBps = BigInt(numberEnv("LOOP_BORROW_BPS", 2000));
const reserveKeepAmount = BigInt(process.env.LOOP_RESERVE_KEEP_AMOUNT || "10000000000000000000000");
const collateralKeepAmount = BigInt(process.env.LOOP_COLLATERAL_KEEP_AMOUNT || "1000000000000000000");
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const reportPath = process.env.LOOP_REPORT_PATH || "reports/scheduled-loop-trade-report.json";
const prepareApprovalsEnabled = (process.env.LOOP_PREPARE_APPROVALS || "true").toLowerCase() === "true";

const provider = new JsonRpcProvider(rpcUrl);
const wallets = privateKeys.slice(0, walletsPerRound).map((key) => new Wallet(key, provider));
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function depositAndBorrow(address token,uint256 collateralAmount,uint256 borrowAmount)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const market = new Contract(marketContractAddress, marketAbi, provider);

console.log(`RPC: ${rpcUrl}`);
console.log(`Market contract: ${marketContractAddress}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Reserve token: ${reserveTokenAddress}`);
console.log(`Wallet pool: ${wallets.length}`);
console.log(`Active wallets per round: ${activeWalletsMin}-${activeWalletsMax}`);
console.log(`Rounds: ${rounds}`);
console.log(`Interval ms: ${intervalMs}`);
console.log(`Max concurrency: ${maxConcurrency}`);
console.log(`Action mode: ${actionMode}`);
console.log(`Buy+borrow probability bps: ${buyBorrowProbabilityBps}`);
console.log(`First buy range: ${firstBuyMin}-${firstBuyMax}`);
console.log(`Borrow bps: ${borrowBps}`);
console.log(`Post-borrow action: ${postBorrowAction}`);
console.log(`Post-borrow amount range: ${postBorrowMin}-${postBorrowMax}`);
console.log(`Sell amount mode: ${sellAmountMode}`);
console.log(`Collateral bps: ${collateralBps}`);
console.log(`Prepare approvals: ${prepareApprovalsEnabled}`);

if (prepareApprovalsEnabled) {
  await prepareApprovals();
} else {
  console.log("Skipping upfront approvals; selected wallets will approve only when needed.");
}

const allResults: LoopResult[] = [];
const startedAt = Date.now();

for (let round = 1; round <= rounds; round++) {
  const scheduledAt = startedAt + (round - 1) * intervalMs;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) {
    console.log(`Waiting ${waitMs}ms before round ${round}...`);
    await sleep(waitMs);
  }

  console.log(`Starting loop round ${round}/${rounds}...`);
  const roundStartedAt = Date.now();
  const selectedWallets = sampleWallets(wallets, randomInt(activeWalletsMin, activeWalletsMax));
  console.log(
    `Round ${round} selected wallets: ${selectedWallets.map(({ index }) => `#${index}`).join(", ")}`
  );
  const tasks = selectedWallets.map(({ wallet, index }) => async () => runWalletLoop(round, index, wallet));
  const roundResults = await runWithConcurrency(tasks, maxConcurrency);
  allResults.push(...roundResults);
  writeReport(allResults);
  console.log(summary(roundResults, `Round ${round}`));
  console.log(`Round ${round} duration: ${Date.now() - roundStartedAt}ms`);
}

writeReport(allResults);
console.log(summary(allResults, "All rounds"));

async function prepareApprovals() {
  console.log("Preparing reserve and collateral approvals...");
  const maxReserveSpend =
    (firstBuyMax + (postBorrowAction === "buy" ? postBorrowMax : 0n)) * BigInt(rounds);
  const maxCollateralApproval = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  const maxSellApproval =
    postBorrowAction === "sell" && sellAmountMode === "remainder-half"
      ? maxCollateralApproval
      : postBorrowMax * BigInt(rounds);

  const tasks = wallets.map((wallet, index) => async () => {
    const reserve = new Contract(reserveTokenAddress, erc20Abi, wallet);
    const collateral = new Contract(tokenAddress, erc20Abi, wallet);

    await approveIfNeeded(index, wallet, reserve, maxReserveSpend, "reserve");
    await approveIfNeeded(index, wallet, collateral, maxCollateralApproval, "collateral");
    if (postBorrowAction === "sell") {
      await approveIfNeeded(index, wallet, collateral, maxSellApproval, "sell");
    }
  });

  await runWithConcurrency(tasks, maxConcurrency);
}

async function approveIfNeeded(index: number, wallet: Wallet, token: Contract, amount: bigint, label: string) {
  const allowance = await token.allowance(wallet.address, marketContractAddress);
  if (allowance >= amount) {
    console.log(`#${index} ${label} allowance OK`);
    return;
  }

  const tx = await token.approve(marketContractAddress, amount);
  console.log(`#${index} ${label} approve tx: ${tx.hash}`);
  const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
  if (receipt?.status !== 1) throw new Error(`${label} approve failed for ${wallet.address}: ${tx.hash}`);
}

async function runWalletLoop(round: number, index: number, wallet: Wallet): Promise<LoopResult> {
  if (actionMode === "buy-borrow-or-sell") {
    const action = Math.floor(Math.random() * 10_000) < buyBorrowProbabilityBps ? "buy-borrow" : "sell";
    const preferredResult = action === "buy-borrow"
      ? runBuyBorrow(round, index, wallet)
      : runSellOnly(round, index, wallet);
    const result = await preferredResult;

    if (result.status !== "skipped") return result;

    console.log(`#${index} round ${round} ${action} skipped, trying fallback action...`);
    return action === "buy-borrow"
      ? runSellOnly(round, index, wallet)
      : runBuyBorrow(round, index, wallet);
  }

  return runBuyBorrow(round, index, wallet, true);
}

async function runBuyBorrow(
  round: number,
  index: number,
  wallet: Wallet,
  includePostBorrowAction = false
): Promise<LoopResult> {
  const startedAt = Date.now();
  const firstBuyAmount = randomBigInt(firstBuyMin, firstBuyMax);
  const borrowAmount = (firstBuyAmount * borrowBps) / 10000n;
  let postBorrowAmount = randomBigInt(postBorrowMin, postBorrowMax);

  try {
    const reserve = new Contract(reserveTokenAddress, erc20Abi, provider);
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const [ethBalance, reserveBalance] = await Promise.all([
      provider.getBalance(wallet.address),
      reserve.balanceOf(wallet.address)
    ]);

    if (ethBalance < minEthWei) {
      return skipped(round, index, wallet, startedAt, "Insufficient ETH for gas", firstBuyAmount, borrowAmount, postBorrowAmount, undefined, "buy-borrow");
    }

    const minimumReserveNeeded =
      firstBuyAmount + (includePostBorrowAction && postBorrowAction === "buy" ? postBorrowAmount : 0n) + reserveKeepAmount;
    if (reserveBalance < minimumReserveNeeded) {
      return skipped(
        round,
        index,
        wallet,
        startedAt,
        `Insufficient reserve token: ${reserveBalance.toString()} < ${minimumReserveNeeded.toString()}`,
        firstBuyAmount,
        borrowAmount,
        postBorrowAmount,
        undefined,
        "buy-borrow"
      );
    }

    const connected = market.connect(wallet) as Contract;
    await approveIfNeeded(index, wallet, new Contract(reserveTokenAddress, erc20Abi, wallet), firstBuyAmount, "reserve");
    const deadline1 = Math.floor(Date.now() / 1000) + deadlineSeconds;
    const firstTx = await connected.buy(tokenAddress, firstBuyAmount, 0, deadline1);
    console.log(`#${index} round ${round} first buy tx: ${firstTx.hash}`);
    const firstReceipt = await waitWithTimeout(firstTx.wait(), receiptTimeoutMs);
    if (firstReceipt?.status !== 1) throw new Error(`First buy failed: ${firstTx.hash}`);

    const tokenBalance = await token.balanceOf(wallet.address);
    if (tokenBalance <= collateralKeepAmount) {
      return skipped(round, index, wallet, startedAt, "No collateral token balance after first buy", firstBuyAmount, borrowAmount, postBorrowAmount, firstTx.hash, "buy-borrow");
    }

    const dynamicSell = includePostBorrowAction && postBorrowAction === "sell" && sellAmountMode === "remainder-half";
    const tokenReserveNeeded = dynamicSell
      ? collateralKeepAmount
      : collateralKeepAmount + (includePostBorrowAction && postBorrowAction === "sell" ? postBorrowAmount : 0n);
    if (tokenBalance <= tokenReserveNeeded) {
      return skipped(
        round,
        index,
        wallet,
        startedAt,
        `Insufficient token for collateral plus post-borrow sell: ${tokenBalance.toString()} <= ${tokenReserveNeeded.toString()}`,
        firstBuyAmount,
        borrowAmount,
        postBorrowAmount,
        firstTx.hash,
        "buy-borrow"
      );
    }

    let collateralAmount = tokenBalance - tokenReserveNeeded;
    if (dynamicSell) {
      collateralAmount = (tokenBalance * collateralBps) / 10000n;
      const maxCollateralAmount = tokenBalance > collateralKeepAmount ? tokenBalance - collateralKeepAmount : 0n;
      if (collateralAmount > maxCollateralAmount) collateralAmount = maxCollateralAmount;
      postBorrowAmount = (tokenBalance - collateralAmount) / 2n;
      if (postBorrowAmount <= 0n) {
        return skipped(
          round,
          index,
          wallet,
          startedAt,
          "No sellable token amount after dynamic collateral calculation",
          firstBuyAmount,
          borrowAmount,
          postBorrowAmount,
          firstTx.hash,
          "buy-borrow"
        );
      }
    }
    await approveIfNeeded(index, wallet, new Contract(tokenAddress, erc20Abi, wallet), collateralAmount, "collateral");
    const borrowTx = await connected.depositAndBorrow(tokenAddress, collateralAmount, borrowAmount);
    console.log(`#${index} round ${round} borrow tx: ${borrowTx.hash}`);
    const borrowReceipt = await waitWithTimeout(borrowTx.wait(), receiptTimeoutMs);
    if (borrowReceipt?.status !== 1) throw new Error(`Borrow failed: ${borrowTx.hash}`);

    let postBorrowHash: string | undefined;
    if (includePostBorrowAction) {
      const deadline2 = Math.floor(Date.now() / 1000) + deadlineSeconds;
      if (postBorrowAction === "buy") {
        await approveIfNeeded(index, wallet, new Contract(reserveTokenAddress, erc20Abi, wallet), postBorrowAmount, "reserve");
      } else {
        await approveIfNeeded(index, wallet, new Contract(tokenAddress, erc20Abi, wallet), postBorrowAmount, "sell");
      }
      const postBorrowTx =
        postBorrowAction === "buy"
          ? await connected.buy(tokenAddress, postBorrowAmount, 0, deadline2)
          : await connected.sell(tokenAddress, postBorrowAmount, 0, deadline2);
      console.log(`#${index} round ${round} ${postBorrowAction} tx: ${postBorrowTx.hash}`);
      const postBorrowReceipt = await waitWithTimeout(postBorrowTx.wait(), receiptTimeoutMs);
      if (postBorrowReceipt?.status !== 1) throw new Error(`Post-borrow ${postBorrowAction} failed: ${postBorrowTx.hash}`);
      postBorrowHash = postBorrowTx.hash;
    }

    return {
      round,
      index,
      wallet: wallet.address,
      action: includePostBorrowAction ? undefined : "buy-borrow",
      status: "confirmed",
      firstBuyAmount: firstBuyAmount.toString(),
      borrowAmount: borrowAmount.toString(),
      collateralAmount: collateralAmount.toString(),
      postBorrowAction: includePostBorrowAction ? postBorrowAction : undefined,
      postBorrowAmount: includePostBorrowAction ? postBorrowAmount.toString() : undefined,
      firstBuyHash: firstTx.hash,
      borrowHash: borrowTx.hash,
      postBorrowHash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      round,
      index,
      wallet: wallet.address,
      action: includePostBorrowAction ? undefined : "buy-borrow",
      status: "failed",
      firstBuyAmount: firstBuyAmount.toString(),
      borrowAmount: borrowAmount.toString(),
      postBorrowAction,
      postBorrowAmount: postBorrowAmount.toString(),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runSellOnly(round: number, index: number, wallet: Wallet): Promise<LoopResult> {
  const startedAt = Date.now();

  try {
    const token = new Contract(tokenAddress, erc20Abi, provider);
    const [ethBalance, tokenBalance] = await Promise.all([
      provider.getBalance(wallet.address),
      token.balanceOf(wallet.address)
    ]);

    if (ethBalance < minEthWei) {
      return skipped(round, index, wallet, startedAt, "Insufficient ETH for gas", 0n, 0n, 0n, undefined, "sell");
    }

    if (tokenBalance <= collateralKeepAmount) {
      return skipped(round, index, wallet, startedAt, "No sellable token balance", 0n, 0n, 0n, undefined, "sell");
    }

    const sellAmount = (tokenBalance - collateralKeepAmount) / 2n;
    if (sellAmount <= 0n) {
      return skipped(round, index, wallet, startedAt, "No sellable token amount after reserve", 0n, 0n, sellAmount, undefined, "sell");
    }

    const connected = market.connect(wallet) as Contract;
    await approveIfNeeded(index, wallet, new Contract(tokenAddress, erc20Abi, wallet), sellAmount, "sell");
    const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
    const tx = await connected.sell(tokenAddress, sellAmount, 0, deadline);
    console.log(`#${index} round ${round} sell-only tx: ${tx.hash}`);
    const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
    if (receipt?.status !== 1) throw new Error(`Sell failed: ${tx.hash}`);

    return {
      round,
      index,
      wallet: wallet.address,
      action: "sell",
      status: "confirmed",
      postBorrowAction: "sell",
      postBorrowAmount: sellAmount.toString(),
      postBorrowHash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      round,
      index,
      wallet: wallet.address,
      action: "sell",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function skipped(
  round: number,
  index: number,
  wallet: Wallet,
  startedAt: number,
  error: string,
  firstBuyAmount: bigint,
  borrowAmount: bigint,
  postBorrowAmount: bigint,
  firstBuyHash?: string,
  action?: "buy-borrow" | "sell"
): LoopResult {
  return {
    round,
    index,
    wallet: wallet.address,
    action,
    status: "skipped",
    firstBuyAmount: firstBuyAmount.toString(),
    borrowAmount: borrowAmount.toString(),
    postBorrowAction,
    postBorrowAmount: postBorrowAmount.toString(),
    firstBuyHash,
    durationMs: Date.now() - startedAt,
    error
  };
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number) {
  const results: T[] = [];
  let next = 0;

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      results[taskIndex] = await tasks[taskIndex]();
    }
  });

  await Promise.all(workers);
  return results;
}

function writeReport(results: LoopResult[]) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ summary: summaryData(results), results }, null, 2));
}

function summary(results: LoopResult[], label: string) {
  return JSON.stringify({ label, ...summaryData(results) }, null, 2);
}

function summaryData(results: LoopResult[]) {
  const durations = results.map((result) => result.durationMs);
  return {
    total: results.length,
    confirmed: results.filter((result) => result.status === "confirmed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    avgDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    maxDurationMs: durations.length ? Math.max(...durations) : 0
  };
}

function randomBigInt(min: bigint, max: bigint) {
  if (max <= min) return min;
  const steps = 1_000_000n;
  const r = BigInt(Math.floor(Math.random() * Number(steps + 1n)));
  return min + ((max - min) * r) / steps;
}

function randomInt(min: number, max: number) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function sampleWallets(pool: Wallet[], count: number) {
  const entries = pool.map((wallet, index) => ({ wallet, index }));

  for (let i = entries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [entries[i], entries[j]] = [entries[j], entries[i]];
  }

  return entries.slice(0, Math.min(count, entries.length));
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

function actionEnv(name: string, fallback: "buy" | "sell") {
  const value = (process.env[name] || fallback).toLowerCase();
  if (value !== "buy" && value !== "sell") throw new Error(`${name} must be buy or sell.`);
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

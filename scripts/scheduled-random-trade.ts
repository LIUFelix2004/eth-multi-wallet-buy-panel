import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, parseUnits, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TradeAction = "buy" | "sell";

type TradeResult = {
  round: number;
  index: number;
  wallet: string;
  action: TradeAction;
  status: "submitted" | "failed" | "skipped";
  amount?: string;
  hash?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const marketContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const tokenAddress = requiredEnv("RANDOM_TRADE_TOKEN_ADDRESS");
const reserveTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const walletsPerRound = numberEnv("RANDOM_TRADE_WALLETS_PER_ROUND", 100);
const rounds = numberEnv("RANDOM_TRADE_ROUNDS", 30);
const intervalMs = numberEnv("RANDOM_TRADE_INTERVAL_MS", 60_000);
const maxConcurrency = numberEnv("RANDOM_TRADE_MAX_CONCURRENCY", numberEnv("MAX_CONCURRENCY", 5));
const buyProbabilityBps = numberEnv("RANDOM_TRADE_BUY_PROBABILITY_BPS", 5000);
const buyAmount = BigInt(requiredEnv("RANDOM_TRADE_BUY_AMOUNT"));
const reserveKeepAmount = BigInt(process.env.RANDOM_TRADE_RESERVE_KEEP_AMOUNT || "10000000000000000000000");
const tokenKeepAmount = BigInt(process.env.RANDOM_TRADE_TOKEN_KEEP_AMOUNT || "1000000000000000000000");
const maxSellAmount = BigInt(process.env.RANDOM_TRADE_MAX_SELL_AMOUNT || "50000000000000000000000");
const sellDivisor = BigInt(numberEnv("RANDOM_TRADE_SELL_DIVISOR", 5));
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const reportPath = process.env.RANDOM_TRADE_REPORT_PATH || "reports/scheduled-random-trade-report.json";

const provider = new JsonRpcProvider(rpcUrl);
const wallets = privateKeys.slice(0, walletsPerRound).map((key) => new Wallet(key, provider));
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)"
];
const market = new Contract(marketContractAddress, marketAbi, provider);
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

new Interface(marketAbi);

console.log(`RPC: ${rpcUrl}`);
console.log(`Market contract: ${marketContractAddress}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Reserve token: ${reserveTokenAddress}`);
console.log(`Wallets per round: ${wallets.length}`);
console.log(`Rounds: ${rounds}`);
console.log(`Interval ms: ${intervalMs}`);
console.log(`Max concurrency: ${maxConcurrency}`);
console.log(`Buy amount: ${buyAmount.toString()}`);
console.log(`Reserve keep amount: ${reserveKeepAmount.toString()}`);
console.log(`Token keep amount: ${tokenKeepAmount.toString()}`);
console.log(`Max sell amount: ${maxSellAmount.toString()}`);

await prepareApprovals();

const allResults: TradeResult[] = [];
const startedAt = Date.now();

for (let round = 1; round <= rounds; round++) {
  const scheduledAt = startedAt + (round - 1) * intervalMs;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) {
    console.log(`Waiting ${waitMs}ms before round ${round}...`);
    await sleep(waitMs);
  }

  console.log(`Starting random trade round ${round}/${rounds}...`);
  const roundStartedAt = Date.now();
  const tasks = wallets.map((wallet, index) => async () => sendRandomTrade(round, index, wallet));
  const roundResults = await runWithConcurrency(tasks, maxConcurrency);
  allResults.push(...roundResults);
  writeReport(allResults);

  console.log(summary(roundResults, `Round ${round}`));
  console.log(`Round ${round} submission duration: ${Date.now() - roundStartedAt}ms`);
}

writeReport(allResults);
console.log(summary(allResults, "All rounds"));

async function prepareApprovals() {
  console.log("Preparing reserve/token approvals...");
  const reserveApproval = buyAmount * BigInt(rounds);

  const tasks = wallets.map((wallet, index) => async () => {
    const reserve = new Contract(reserveTokenAddress, erc20Abi, wallet);
    const token = new Contract(tokenAddress, erc20Abi, wallet);

    await approveIfNeeded(index, wallet, reserve, reserveApproval, "reserve");
    await approveIfNeeded(index, wallet, token, maxSellAmount * BigInt(rounds), "token");
  });

  await runWithConcurrency(tasks, maxConcurrency);
}

async function approveIfNeeded(
  index: number,
  wallet: Wallet,
  token: Contract,
  amount: bigint,
  label: string
) {
  const allowance = await token.allowance(wallet.address, marketContractAddress);
  if (allowance >= amount) {
    console.log(`#${index} ${label} allowance OK`);
    return;
  }

  const tx = await token.approve(marketContractAddress, amount);
  console.log(`#${index} ${label} approve tx: ${tx.hash}`);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`${label} approve failed for ${wallet.address}: ${tx.hash}`);
}

async function sendRandomTrade(round: number, index: number, wallet: Wallet): Promise<TradeResult> {
  const startedAt = Date.now();
  const preferredAction = Math.floor(Math.random() * 10_000) < buyProbabilityBps ? "buy" : "sell";

  try {
    const action = await chooseExecutableAction(wallet, preferredAction);
    if (!action) {
      return {
        round,
        index,
        wallet: wallet.address,
        action: preferredAction,
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: "Neither buy nor sell is executable without breaching balance reserves"
      };
    }

    const connected = market.connect(wallet) as Contract;
    const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

    if (action === "buy") {
      const tx = await connected.buy(tokenAddress, buyAmount, 0, deadline);
      return {
        round,
        index,
        wallet: wallet.address,
        action,
        status: "submitted",
        amount: buyAmount.toString(),
        hash: tx.hash,
        durationMs: Date.now() - startedAt
      };
    }

    const sellAmount = await computeSellAmount(wallet);
    if (sellAmount <= 0n) {
      return {
        round,
        index,
        wallet: wallet.address,
        action,
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: "No sellable token balance above reserve"
      };
    }

    const tx = await connected.sell(tokenAddress, sellAmount, 0, deadline);
    return {
      round,
      index,
      wallet: wallet.address,
      action,
      status: "submitted",
      amount: sellAmount.toString(),
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      round,
      index,
      wallet: wallet.address,
      action: preferredAction,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function chooseExecutableAction(wallet: Wallet, preferred: TradeAction): Promise<TradeAction | null> {
  if (preferred === "buy") {
    if (await canBuy(wallet)) return "buy";
    if (await canSell(wallet)) return "sell";
    return null;
  }

  if (await canSell(wallet)) return "sell";
  if (await canBuy(wallet)) return "buy";
  return null;
}

async function canBuy(wallet: Wallet) {
  const [ethBalance, reserveBalance, allowance] = await Promise.all([
    provider.getBalance(wallet.address),
    new Contract(reserveTokenAddress, erc20Abi, provider).balanceOf(wallet.address),
    new Contract(reserveTokenAddress, erc20Abi, provider).allowance(wallet.address, marketContractAddress)
  ]);

  return ethBalance >= minEthWei && reserveBalance >= buyAmount + reserveKeepAmount && allowance >= buyAmount;
}

async function canSell(wallet: Wallet) {
  const sellAmount = await computeSellAmount(wallet);
  if (sellAmount <= 0n) return false;

  const [ethBalance, allowance] = await Promise.all([
    provider.getBalance(wallet.address),
    new Contract(tokenAddress, erc20Abi, provider).allowance(wallet.address, marketContractAddress)
  ]);

  return ethBalance >= minEthWei && allowance >= sellAmount;
}

async function computeSellAmount(wallet: Wallet) {
  const token = new Contract(tokenAddress, erc20Abi, provider);
  const balance = await token.balanceOf(wallet.address);
  if (balance <= tokenKeepAmount) return 0n;

  const sellable = balance - tokenKeepAmount;
  const fraction = sellable / sellDivisor;
  let amount = fraction > 0n ? fraction : sellable;
  if (amount > maxSellAmount) amount = maxSellAmount;
  return amount;
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

function writeReport(results: TradeResult[]) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ summary: summaryData(results), results }, null, 2));
}

function summary(results: TradeResult[], label: string) {
  return JSON.stringify({ label, ...summaryData(results) }, null, 2);
}

function summaryData(results: TradeResult[]) {
  const durations = results.map((result) => result.durationMs);
  return {
    total: results.length,
    buy: results.filter((result) => result.action === "buy").length,
    sell: results.filter((result) => result.action === "sell").length,
    submitted: results.filter((result) => result.status === "submitted").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    avgDurationMs: durations.length
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : 0,
    maxDurationMs: durations.length ? Math.max(...durations) : 0
  };
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

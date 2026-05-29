import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, parseEther, parseUnits, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TxResult = {
  round: number;
  index: number;
  wallet: string;
  status: "submitted" | "failed" | "skipped";
  hash?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const buyContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const buyFunctionSignature = requiredEnv("BUY_FUNCTION_SIGNATURE");
const buyArgs = JSON.parse(process.env.BUY_ARGS_JSON || "[]");
const buyValueEth = process.env.BUY_VALUE_ETH || "0";
const paymentTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const walletsPerRound = numberEnv("SCHEDULED_WALLETS_PER_ROUND", 100);
const rounds = numberEnv("SCHEDULED_ROUNDS", 30);
const intervalMs = numberEnv("SCHEDULED_INTERVAL_MS", 60_000);
const maxConcurrency = numberEnv("MAX_CONCURRENCY", 5);
const buyAmount = BigInt(requiredEnv("SCHEDULED_BUY_AMOUNT"));
const totalApprovalAmount = buyAmount * BigInt(rounds);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const reportPath = process.env.SCHEDULED_BUY_REPORT_PATH || "reports/scheduled-buy-report.json";
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);

const provider = new JsonRpcProvider(rpcUrl);
const iface = new Interface([buyFunctionSignature]);
const fragment = iface.fragments.find((item) => item.type === "function");

if (!fragment || fragment.type !== "function") {
  throw new Error("BUY_FUNCTION_SIGNATURE must be a function ABI fragment.");
}

const functionName = fragment.name;
const wallets = privateKeys.slice(0, walletsPerRound).map((key) => new Wallet(key, provider));
const contract = new Contract(buyContractAddress, [buyFunctionSignature], provider);
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

console.log(`RPC: ${rpcUrl}`);
console.log(`Contract: ${buyContractAddress}`);
console.log(`Function: ${functionName}`);
console.log(`Payment token: ${paymentTokenAddress}`);
console.log(`Wallets per round: ${wallets.length}`);
console.log(`Rounds: ${rounds}`);
console.log(`Interval ms: ${intervalMs}`);
console.log(`Buy amount per wallet per round: ${buyAmount.toString()}`);
console.log(`Total approval amount per wallet: ${totalApprovalAmount.toString()}`);
console.log(`Max concurrency: ${maxConcurrency}`);

await prepareWallets();

const allResults: TxResult[] = [];
const startedAt = Date.now();

for (let round = 1; round <= rounds; round++) {
  const scheduledAt = startedAt + (round - 1) * intervalMs;
  const waitMs = scheduledAt - Date.now();
  if (waitMs > 0) {
    console.log(`Waiting ${waitMs}ms before round ${round}...`);
    await sleep(waitMs);
  }

  console.log(`Starting round ${round}/${rounds}...`);
  const roundStartedAt = Date.now();
  const tasks = wallets.map((wallet, index) => async () => sendBuy(round, index, wallet));
  const roundResults = await runWithConcurrency(tasks, maxConcurrency);
  allResults.push(...roundResults);
  writeReport(allResults);
  console.log(summary(roundResults, `Round ${round}`));
  console.log(`Round ${round} submission duration: ${Date.now() - roundStartedAt}ms`);
}

writeReport(allResults);
console.log(summary(allResults, "All rounds"));

async function prepareWallets() {
  console.log("Checking balances and preparing approvals...");
  const tasks = wallets.map((wallet, index) => async () => {
    const token = new Contract(paymentTokenAddress, erc20Abi, wallet);
    const [ethBalance, tokenBalance, allowance] = await Promise.all([
      provider.getBalance(wallet.address),
      token.balanceOf(wallet.address),
      token.allowance(wallet.address, buyContractAddress)
    ]);

    if (ethBalance < minEthWei) {
      console.log(`#${index} ${wallet.address} low ETH: ${ethBalance.toString()}`);
      return;
    }

    if (tokenBalance < totalApprovalAmount) {
      console.log(`#${index} ${wallet.address} low payment token: ${tokenBalance.toString()} < ${totalApprovalAmount.toString()}`);
      return;
    }

    if (allowance >= totalApprovalAmount) {
      console.log(`#${index} ${wallet.address} allowance OK`);
      return;
    }

    const tx = await token.approve(buyContractAddress, totalApprovalAmount);
    console.log(`#${index} ${wallet.address} approve tx: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error(`Approve failed for ${wallet.address}: ${tx.hash}`);
  });

  await runWithConcurrency(tasks, maxConcurrency);
}

async function sendBuy(round: number, index: number, wallet: Wallet): Promise<TxResult> {
  const startedAt = Date.now();

  try {
    const skipReason = await getSkipReason(wallet);
    if (skipReason) {
      return {
        round,
        index,
        wallet: wallet.address,
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: skipReason
      };
    }

    const connected = contract.connect(wallet) as Contract;
    const resolvedBuyArgs = resolveArgsForWallet(buyArgs, wallet);
    const tx = await connected[functionName](...resolvedBuyArgs, buildOverrides());

    return {
      round,
      index,
      wallet: wallet.address,
      status: "submitted",
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      round,
      index,
      wallet: wallet.address,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getSkipReason(wallet: Wallet) {
  const token = new Contract(paymentTokenAddress, erc20Abi, provider);
  const [ethBalance, tokenBalance, allowance] = await Promise.all([
    provider.getBalance(wallet.address),
    token.balanceOf(wallet.address),
    token.allowance(wallet.address, buyContractAddress)
  ]);

  if (ethBalance < minEthWei) {
    return `Insufficient ETH for gas: ${ethBalance.toString()} < ${minEthWei.toString()}`;
  }

  if (tokenBalance < buyAmount) {
    return `Insufficient payment token: ${tokenBalance.toString()} < ${buyAmount.toString()}`;
  }

  if (allowance < buyAmount) {
    return `Insufficient allowance: ${allowance.toString()} < ${buyAmount.toString()}`;
  }

  return "";
}

function buildOverrides() {
  const overrides: Record<string, unknown> = {
    value: parseEther(buyValueEth)
  };

  if (process.env.MAX_FEE_GWEI) {
    overrides.maxFeePerGas = parseUnits(process.env.MAX_FEE_GWEI, "gwei");
  }

  if (process.env.MAX_PRIORITY_FEE_GWEI) {
    overrides.maxPriorityFeePerGas = parseUnits(process.env.MAX_PRIORITY_FEE_GWEI, "gwei");
  }

  return overrides;
}

function resolveArgsForWallet(args: unknown[], wallet: Wallet) {
  return args.map((arg) => {
    if (arg === "$WALLET") return wallet.address;
    if (arg === "$DEADLINE") return Math.floor(Date.now() / 1000) + deadlineSeconds;
    return arg;
  });
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

function writeReport(results: TxResult[]) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ summary: summaryData(results), results }, null, 2));
}

function summary(results: TxResult[], label: string) {
  return JSON.stringify({ label, ...summaryData(results) }, null, 2);
}

function summaryData(results: TxResult[]) {
  const durations = results.map((result) => result.durationMs);
  return {
    total: results.length,
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
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function numberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number.`);
  }

  return value;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

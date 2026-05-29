import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TxResult = {
  index: number;
  wallet: string;
  status: "confirmed" | "failed" | "skipped";
  hash?: string;
  blockNumber?: number;
  gasUsed?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const sellContractAddress = process.env.SELL_CONTRACT_ADDRESS || requiredEnv("BUY_CONTRACT_ADDRESS");
const sellFunctionSignature = requiredEnv("SELL_FUNCTION_SIGNATURE");
const sellArgs = JSON.parse(process.env.SELL_ARGS_JSON || "[]");
const sellTokenAddress = requiredEnv("SELL_TOKEN_ADDRESS");
const sellApproveAmount = BigInt(requiredEnv("SELL_APPROVE_AMOUNT"));
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const totalSells = numberEnv("TOTAL_SELLS", numberEnv("TOTAL_BUYS", 100));
const maxConcurrency = numberEnv("SELL_MAX_CONCURRENCY", numberEnv("MAX_CONCURRENCY", 20));
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const reportPath = process.env.SELL_REPORT_PATH || "reports/multi-sell-report.json";
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");

const provider = new JsonRpcProvider(rpcUrl);
const iface = new Interface([sellFunctionSignature]);
const fragment = iface.fragments.find((item) => item.type === "function");

if (!fragment || fragment.type !== "function") {
  throw new Error("SELL_FUNCTION_SIGNATURE must be a function ABI fragment.");
}

const functionName = fragment.name;
const wallets = privateKeys.map((key) => new Wallet(key, provider));
const contract = new Contract(sellContractAddress, [sellFunctionSignature], provider);
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

console.log(`RPC: ${rpcUrl}`);
console.log(`Contract: ${sellContractAddress}`);
console.log(`Function: ${functionName}`);
console.log(`Sell token: ${sellTokenAddress}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Total sells: ${totalSells}`);
console.log(`Max concurrency: ${maxConcurrency}`);

const tasks = Array.from({ length: totalSells }, (_, index) => async () => {
  const wallet = wallets[index % wallets.length];
  return sendSell(index, wallet);
});

const results = await runWithConcurrency(tasks, maxConcurrency);
writeReport(results);

console.log(summary(results));

async function sendSell(index: number, wallet: Wallet): Promise<TxResult> {
  const startedAt = Date.now();

  try {
    const skipReason = await getSkipReason(wallet);
    if (skipReason) {
      return {
        index,
        wallet: wallet.address,
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: skipReason
      };
    }

    await approveIfNeeded(wallet);

    const connected = contract.connect(wallet) as Contract;
    const resolvedSellArgs = resolveArgsForWallet(sellArgs, wallet);
    const tx = await connected[functionName](...resolvedSellArgs);
    const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);

    return {
      index,
      wallet: wallet.address,
      status: receipt?.status === 1 ? "confirmed" : "failed",
      hash: tx.hash,
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      index,
      wallet: wallet.address,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getSkipReason(wallet: Wallet) {
  const ethBalance = await provider.getBalance(wallet.address);
  if (ethBalance < minEthWei) {
    return `Insufficient ETH for gas: ${ethBalance.toString()} < ${minEthWei.toString()}`;
  }

  const token = new Contract(sellTokenAddress, erc20Abi, provider);
  const balance = await token.balanceOf(wallet.address);
  if (balance < sellApproveAmount) {
    return `Insufficient sell token: ${balance.toString()} < ${sellApproveAmount.toString()}`;
  }

  return "";
}

async function approveIfNeeded(wallet: Wallet) {
  const token = new Contract(sellTokenAddress, erc20Abi, wallet);
  const current = await token.allowance(wallet.address, sellContractAddress);

  if (current >= sellApproveAmount) return;

  const tx = await token.approve(sellContractAddress, sellApproveAmount);
  await waitWithTimeout(tx.wait(), receiptTimeoutMs);
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

function resolveArgsForWallet(args: unknown[], wallet: Wallet) {
  return args.map((arg) => {
    if (arg === "$WALLET") return wallet.address;
    if (arg === "$DEADLINE") return Math.floor(Date.now() / 1000) + deadlineSeconds;
    return arg;
  });
}

function writeReport(results: TxResult[]) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ summary: summaryData(results), results }, null, 2));
  console.log(`Report written to ${reportPath}`);
}

function summary(results: TxResult[]) {
  return JSON.stringify(summaryData(results), null, 2);
}

function summaryData(results: TxResult[]) {
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

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Copy .env.example to .env and set ${name}.`);
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

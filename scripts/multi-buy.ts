import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, parseEther, parseUnits, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TxResult = {
  index: number;
  wallet: string;
  status: "submitted" | "confirmed" | "failed" | "skipped";
  hash?: string;
  blockNumber?: number;
  gasUsed?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const buyContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const buyFunctionSignature = requiredEnv("BUY_FUNCTION_SIGNATURE");
const buyArgs = JSON.parse(process.env.BUY_ARGS_JSON || "[]");
const buyValueEth = process.env.BUY_VALUE_ETH || "0";
const paymentTokenAddress = process.env.PAYMENT_TOKEN_ADDRESS;
const approveAmount = process.env.APPROVE_AMOUNT;
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const totalBuys = numberEnv("TOTAL_BUYS", 100);
const maxConcurrency = numberEnv("MAX_CONCURRENCY", 20);
const waitForReceipt = (process.env.WAIT_FOR_RECEIPT || "true").toLowerCase() === "true";
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const reportPath = process.env.REPORT_PATH || "reports/multi-buy-report.json";

if (privateKeys.length === 0) {
  throw new Error("PRIVATE_KEYS must contain at least one funded Sepolia wallet private key.");
}

const provider = new JsonRpcProvider(rpcUrl);
const iface = new Interface([buyFunctionSignature]);
const fragment = iface.fragments.find((item) => item.type === "function");

if (!fragment || fragment.type !== "function") {
  throw new Error("BUY_FUNCTION_SIGNATURE must be a function ABI fragment.");
}

const functionName = fragment.name;
const wallets = privateKeys.map((key) => new Wallet(key, provider));
const contract = new Contract(buyContractAddress, [buyFunctionSignature], provider);
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

console.log(`RPC: ${rpcUrl}`);
console.log(`Contract: ${buyContractAddress}`);
console.log(`Function: ${functionName}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Total buys: ${totalBuys}`);
console.log(`Max concurrency: ${maxConcurrency}`);

const tasks = Array.from({ length: totalBuys }, (_, index) => async () => {
  const wallet = wallets[index % wallets.length];
  return sendBuy(index, wallet);
});

const results = await runWithConcurrency(tasks, maxConcurrency);
writeReport(results);

console.log(summary(results));

async function sendBuy(index: number, wallet: Wallet): Promise<TxResult> {
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

    if (paymentTokenAddress && approveAmount) {
      await approveIfNeeded(wallet);
    }

    const connected = contract.connect(wallet) as Contract;
    const overrides = buildOverrides();
    const resolvedBuyArgs = resolveArgsForWallet(buyArgs, wallet);
    const tx = await connected[functionName](...resolvedBuyArgs, overrides);

    if (!waitForReceipt) {
      return {
        index,
        wallet: wallet.address,
        status: "submitted",
        hash: tx.hash,
        durationMs: Date.now() - startedAt
      };
    }

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

  if (paymentTokenAddress && approveAmount) {
    const token = new Contract(paymentTokenAddress, erc20Abi, provider);
    const balance = await token.balanceOf(wallet.address);
    const required = BigInt(approveAmount);
    if (balance < required) {
      return `Insufficient payment token: ${balance.toString()} < ${required.toString()}`;
    }
  }

  return "";
}

async function approveIfNeeded(wallet: Wallet) {
  const token = new Contract(paymentTokenAddress!, erc20Abi, wallet);
  const required = BigInt(approveAmount!);
  const current = await token.allowance(wallet.address, buyContractAddress);

  if (current >= required) return;

  const tx = await token.approve(buyContractAddress, required);
  await waitWithTimeout(tx.wait(), receiptTimeoutMs);
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
  console.log(`Report written to ${reportPath}`);
}

function summary(results: TxResult[]) {
  return JSON.stringify(summaryData(results), null, 2);
}

function summaryData(results: TxResult[]) {
  const durations = results.map((result) => result.durationMs);
  return {
    total: results.length,
    submitted: results.filter((result) => result.status === "submitted").length,
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

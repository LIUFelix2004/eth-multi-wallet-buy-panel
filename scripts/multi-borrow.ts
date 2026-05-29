import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type TxResult = {
  index: number;
  wallet: string;
  status: "confirmed" | "failed" | "skipped";
  borrowAmount?: string;
  depositAmount?: string;
  depositHash?: string;
  hash?: string;
  blockNumber?: number;
  gasUsed?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const borrowContractAddress = process.env.BORROW_CONTRACT_ADDRESS || requiredEnv("BUY_CONTRACT_ADDRESS");
const borrowFunctionSignature =
  process.env.BORROW_FUNCTION_SIGNATURE || "function borrow(address token,uint256 amount)";
const borrowTokenAddress = requiredEnv("BORROW_TOKEN_ADDRESS");
const depositBeforeBorrow = (process.env.DEPOSIT_BEFORE_BORROW || "false").toLowerCase() === "true";
const depositFunctionSignature = process.env.DEPOSIT_FUNCTION_SIGNATURE || "function deposit(address token,uint256 amount)";
const collateralTokenAddress = process.env.COLLATERAL_TOKEN_ADDRESS || borrowTokenAddress;
const collateralReserveAmount = BigInt(process.env.COLLATERAL_RESERVE_AMOUNT || "0");
const maxDepositAmount = process.env.MAX_DEPOSIT_AMOUNT ? BigInt(process.env.MAX_DEPOSIT_AMOUNT) : undefined;
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const totalBorrows = numberEnv("TOTAL_BORROWS", 100);
const maxConcurrency = numberEnv("BORROW_MAX_CONCURRENCY", 20);
const probeConcurrency = numberEnv("BORROW_PROBE_CONCURRENCY", 10);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const reportPath = process.env.BORROW_REPORT_PATH || "reports/multi-borrow-report.json";
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const probeStart = BigInt(process.env.BORROW_PROBE_START || "1000000000000000000000");
const probeCap = BigInt(process.env.BORROW_PROBE_CAP || "10000000000000000000000000");
const binarySteps = numberEnv("BORROW_BINARY_STEPS", 48);
const safetyBps = BigInt(numberEnv("BORROW_SAFETY_BPS", 10000));

const provider = new JsonRpcProvider(rpcUrl);
const iface = new Interface([borrowFunctionSignature]);
const fragment = iface.fragments.find((item) => item.type === "function");

if (!fragment || fragment.type !== "function") {
  throw new Error("BORROW_FUNCTION_SIGNATURE must be a function ABI fragment.");
}

const functionName = fragment.name;
const wallets = privateKeys.map((key) => new Wallet(key, provider));
const contract = new Contract(borrowContractAddress, [borrowFunctionSignature], provider);
const depositContract = new Contract(borrowContractAddress, [depositFunctionSignature], provider);
const collateralErc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

console.log(`RPC: ${rpcUrl}`);
console.log(`Contract: ${borrowContractAddress}`);
console.log(`Function: ${functionName}`);
console.log(`Borrow token: ${borrowTokenAddress}`);
console.log(`Deposit before borrow: ${depositBeforeBorrow}`);
console.log(`Collateral token: ${collateralTokenAddress}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Total borrows: ${totalBorrows}`);
console.log(`Max concurrency: ${maxConcurrency}`);
console.log(`Probe concurrency: ${probeConcurrency}`);

const selectedWallets = wallets.slice(0, totalBorrows);
const depositResults = depositBeforeBorrow
  ? await depositCollateralForWallets(selectedWallets)
  : selectedWallets.map(() => ({ amount: 0n, hash: "" }));
const borrowAmounts = await discoverBorrowAmounts(selectedWallets);
const tasks = selectedWallets.map((wallet, index) => async () => {
  return sendBorrow(index, wallet, borrowAmounts[index] ?? 0n, depositResults[index]);
});

const results = await runWithConcurrency(tasks, maxConcurrency);
writeReport(results);

console.log(summary(results));

async function discoverBorrowAmounts(selected: Wallet[]) {
  console.log("Discovering max borrow amounts with static calls...");
  const tasks = selected.map((wallet, index) => async () => {
    const startedAt = Date.now();

    try {
      const amount = await findMaxBorrow(wallet);
      const safeAmount = (amount * safetyBps) / 10000n;
      console.log(`#${index} ${wallet.address} max=${amount.toString()} safe=${safeAmount.toString()} in ${Date.now() - startedAt}ms`);
      return safeAmount;
    } catch (error) {
      console.log(`#${index} ${wallet.address} probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0n;
    }
  });

  return runWithConcurrency(tasks, probeConcurrency);
}

async function depositCollateralForWallets(selected: Wallet[]) {
  console.log("Depositing collateral before borrow...");
  const tasks = selected.map((wallet, index) => async () => {
    const startedAt = Date.now();

    try {
      const amount = await getDepositAmount(wallet);
      if (amount <= 0n) {
        console.log(`#${index} ${wallet.address} deposit skipped: no collateral balance`);
        return { amount: 0n, hash: "" };
      }

      await approveCollateralIfNeeded(wallet, amount);
      const connected = depositContract.connect(wallet) as Contract;
      const fragment = new Interface([depositFunctionSignature]).fragments.find((item) => item.type === "function");
      if (!fragment || fragment.type !== "function") throw new Error("Invalid deposit function signature.");

      const tx = await connected[fragment.name](collateralTokenAddress, amount);
      console.log(`#${index} ${wallet.address} deposit=${amount.toString()} tx=${tx.hash}`);
      const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
      if (receipt?.status !== 1) throw new Error(`Deposit failed: ${tx.hash}`);
      console.log(`#${index} ${wallet.address} deposit confirmed in ${Date.now() - startedAt}ms`);
      return { amount, hash: tx.hash };
    } catch (error) {
      console.log(`#${index} ${wallet.address} deposit failed: ${error instanceof Error ? error.message : String(error)}`);
      return { amount: 0n, hash: "" };
    }
  });

  return runWithConcurrency(tasks, maxConcurrency);
}

async function sendBorrow(
  index: number,
  wallet: Wallet,
  amount: bigint,
  depositResult?: { amount: bigint; hash: string }
): Promise<TxResult> {
  const startedAt = Date.now();

  try {
    const ethBalance = await provider.getBalance(wallet.address);
    if (ethBalance < minEthWei) {
      return {
        index,
        wallet: wallet.address,
        status: "skipped",
        borrowAmount: amount.toString(),
        depositAmount: depositResult?.amount.toString(),
        depositHash: depositResult?.hash,
        durationMs: Date.now() - startedAt,
        error: `Insufficient ETH for gas: ${ethBalance.toString()} < ${minEthWei.toString()}`
      };
    }

    if (amount <= 0n) {
      return {
        index,
        wallet: wallet.address,
        status: "skipped",
        borrowAmount: amount.toString(),
        depositAmount: depositResult?.amount.toString(),
        depositHash: depositResult?.hash,
        durationMs: Date.now() - startedAt,
        error: "No borrowable amount discovered"
      };
    }

    const connected = contract.connect(wallet) as Contract;
    const tx = await connected[functionName](borrowTokenAddress, amount);
    const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);

    return {
      index,
      wallet: wallet.address,
      status: receipt?.status === 1 ? "confirmed" : "failed",
      borrowAmount: amount.toString(),
      depositAmount: depositResult?.amount.toString(),
      depositHash: depositResult?.hash,
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
      borrowAmount: amount.toString(),
      depositAmount: depositResult?.amount.toString(),
      depositHash: depositResult?.hash,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getDepositAmount(wallet: Wallet) {
  const token = new Contract(collateralTokenAddress, collateralErc20Abi, provider);
  const balance = await token.balanceOf(wallet.address);

  if (balance <= collateralReserveAmount) return 0n;

  const available = balance - collateralReserveAmount;
  if (maxDepositAmount !== undefined && available > maxDepositAmount) return maxDepositAmount;
  return available;
}

async function approveCollateralIfNeeded(wallet: Wallet, amount: bigint) {
  const token = new Contract(collateralTokenAddress, collateralErc20Abi, wallet);
  const current = await token.allowance(wallet.address, borrowContractAddress);
  if (current >= amount) return;

  const tx = await token.approve(borrowContractAddress, amount);
  await waitWithTimeout(tx.wait(), receiptTimeoutMs);
}

async function findMaxBorrow(wallet: Wallet) {
  const connected = contract.connect(wallet) as Contract;

  if (!(await canBorrow(connected, probeStart))) return 0n;

  let low = probeStart;
  let high = probeStart * 2n;

  while (high <= probeCap && (await canBorrow(connected, high))) {
    low = high;
    high *= 2n;
  }

  if (high > probeCap) high = probeCap;

  for (let i = 0; i < binarySteps; i++) {
    const mid = (low + high + 1n) / 2n;
    if (mid === low || mid === high) break;

    if (await canBorrow(connected, mid)) {
      low = mid;
    } else {
      high = mid - 1n;
    }
  }

  return low;
}

async function canBorrow(connected: Contract, amount: bigint) {
  try {
    await connected[functionName].staticCall(borrowTokenAddress, amount);
    return true;
  } catch {
    return false;
  }
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
    confirmed: results.filter((result) => result.status === "confirmed").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    failed: results.filter((result) => result.status === "failed").length,
    totalBorrowAmount: results
      .filter((result) => result.status === "confirmed" && result.borrowAmount)
      .reduce((sum, result) => sum + BigInt(result.borrowAmount!), 0n)
      .toString(),
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

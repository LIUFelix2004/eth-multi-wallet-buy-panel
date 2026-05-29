import "dotenv/config";
import { Contract, JsonRpcProvider, Wallet, parseUnits } from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

type WalletEntry = {
  index: number;
  address: string;
  privateKey: string;
};

type TxResult = {
  profile: string;
  concurrency: number;
  round: number;
  index: number;
  wallet: string;
  status: "confirmed" | "failed" | "skipped" | "submitted";
  hash?: string;
  blockNumber?: number;
  gasUsed?: string;
  durationMs: number;
  error?: string;
};

type RoundSummary = {
  profile: string;
  concurrency: number;
  round: number;
  total: number;
  confirmed: number;
  failed: number;
  skipped: number;
  submitted: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  failedReasons: string[];
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  PRIVATE_KEYS=... REFERRAL_TARGET_TOKEN_ADDRESS=0x... npm run round-batch-buy

Env:
  RPC_URL                 default https://ethereum-sepolia-rpc.publicnode.com
  BUY_CONTRACT_ADDRESS    router/market contract
  PRIVATE_KEYS            comma separated wallets
  REFERRAL_TARGET_TOKEN_ADDRESS
  ROUND_BUY_AMOUNT_USDT   default 1000
  ROUND_COUNT             default 3
  ROUND_CONCURRENCY       default 10
  ROUND_CONCURRENCY_MATRIX optional csv like 10,50,100
  ROUND_REPORT_BASE       output base path without extension
`);
  process.exit(0);
}

const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const buyContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const paymentTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const targetTokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const buyAmountUsdt = process.env.ROUND_BUY_AMOUNT_USDT || "1000";
const roundCount = numberEnv("ROUND_COUNT", 3);
const defaultConcurrency = numberEnv("ROUND_CONCURRENCY", 10);
const concurrencyMatrix = parseConcurrencyMatrix(process.env.ROUND_CONCURRENCY_MATRIX);
const receiptTimeoutMs = numberEnv("ROUND_RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const reportBase =
  process.env.ROUND_REPORT_BASE ||
  `reports/round-batch-buy-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`;
const waitForReceipt = (process.env.ROUND_WAIT_FOR_RECEIPT || "true").toLowerCase() === "true";

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
const marketAbi = ["function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)"];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender,uint256 amount) returns (bool)"
];

const usdt = new Contract(paymentTokenAddress, erc20Abi, provider);
const token = new Contract(targetTokenAddress, erc20Abi, provider);
const [usdtDecimals, targetSymbol] = await Promise.all([
  usdt.decimals(),
  token.symbol().catch(() => "TOKEN")
]);
const buyAmountRaw = parseUnits(buyAmountUsdt, usdtDecimals);
const wallets = privateKeys.map((key, index) => {
  const wallet = new Wallet(key, provider);
  return { index, address: wallet.address, privateKey: key };
});

console.log(`RPC: ${rpcUrl}`);
console.log(`Router: ${buyContractAddress}`);
console.log(`Target: ${targetTokenAddress} (${targetSymbol})`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Buy amount: ${buyAmountUsdt}`);
console.log(`Default rounds: ${roundCount}`);
console.log(`Default concurrency: ${defaultConcurrency}`);
if (concurrencyMatrix.length > 0) {
  console.log(`Concurrency matrix: ${concurrencyMatrix.join(", ")}`);
}
console.log(`Report base: ${reportBase}`);

const existing = loadExistingReport();
const allResults: TxResult[] = existing.results;
const roundSummaries: RoundSummary[] = existing.summary;

const profiles =
  concurrencyMatrix.length > 0
    ? concurrencyMatrix.map((value) => ({ profile: `并发${value}`, concurrency: value, rounds: roundCount }))
    : [{ profile: `并发${defaultConcurrency}`, concurrency: defaultConcurrency, rounds: roundCount }];

for (const profile of profiles) {
  const startRound = nextRoundNumber(roundSummaries, profile.profile);
  for (let i = 0; i < profile.rounds; i++) {
    const round = startRound + i;
    console.log(`${profile.profile} 第 ${round} 轮 starting...`);
    const roundResults = await runRound(profile.profile, profile.concurrency, round);
    allResults.push(...roundResults);
    const summary = summarizeRound(profile.profile, profile.concurrency, round, roundResults);
    roundSummaries.push(summary);
    writeReport(roundSummaries, allResults);
    console.log(`${profile.profile} 第 ${round} 轮 done: ${JSON.stringify(summary)}`);
  }
}

writeReport(roundSummaries, allResults);
console.log(`Finished. Excel: ${reportBase}.xlsx`);

async function runRound(profile: string, concurrency: number, round: number) {
  const tasks = wallets.map((entry) => async () => executeBuy(profile, concurrency, round, entry));
  return runWithConcurrency(tasks, concurrency);
}

async function executeBuy(profile: string, concurrency: number, round: number, entry: WalletEntry): Promise<TxResult> {
  const startedAt = Date.now();
  const wallet = new Wallet(entry.privateKey, provider);
  const connectedMarket = new Contract(buyContractAddress, marketAbi, wallet);
  const connectedUsdt = new Contract(paymentTokenAddress, erc20Abi, wallet);

  try {
    const gasBalance = await provider.getBalance(wallet.address);
    if (gasBalance <= 0n) {
      return {
        profile,
        concurrency,
        round,
        index: entry.index,
        wallet: wallet.address,
        status: "skipped",
        durationMs: Date.now() - startedAt,
        error: "Insufficient ETH for gas"
      };
    }

    const allowance = await connectedUsdt.allowance(wallet.address, buyContractAddress);
    if (allowance < buyAmountRaw) {
      const atx = await connectedUsdt.approve(buyContractAddress, buyAmountRaw);
      const receipt = await waitWithTimeout(atx.wait(), receiptTimeoutMs);
      if (receipt?.status !== 1) throw new Error(`Approve failed: ${atx.hash}`);
    }

    const before = await token.balanceOf(wallet.address);
    const tx = await connectedMarket.buy(
      targetTokenAddress,
      buyAmountRaw,
      0,
      Math.floor(Date.now() / 1000) + deadlineSeconds
    );

    if (!waitForReceipt) {
      return {
        profile,
        concurrency,
        round,
        index: entry.index,
        wallet: wallet.address,
        status: "submitted",
        hash: tx.hash,
        durationMs: Date.now() - startedAt
      };
    }

    const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return {
        profile,
        concurrency,
        round,
        index: entry.index,
        wallet: wallet.address,
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        gasUsed: receipt?.gasUsed?.toString(),
        durationMs: Date.now() - startedAt,
        error: `tx reverted: ${tx.hash}`
      };
    }

    const after = await token.balanceOf(wallet.address);
    const bought = after > before ? after - before : 0n;

    return {
      profile,
      concurrency,
      round,
      index: entry.index,
      wallet: wallet.address,
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt?.blockNumber,
      gasUsed: receipt?.gasUsed?.toString(),
      durationMs: Date.now() - startedAt,
      error: bought > 0n ? undefined : "buy confirmed but token delta is 0"
    };
  } catch (error) {
    return {
      profile,
      concurrency,
      round,
      index: entry.index,
      wallet: wallet.address,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function summarizeRound(profile: string, concurrency: number, round: number, results: TxResult[]): RoundSummary {
  const durations = results.map((item) => item.durationMs);
  return {
    profile,
    concurrency,
    round,
    total: results.length,
    confirmed: results.filter((item) => item.status === "confirmed").length,
    failed: results.filter((item) => item.status === "failed").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    submitted: results.filter((item) => item.status === "submitted").length,
    avgLatencyMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    maxLatencyMs: durations.length ? Math.max(...durations) : 0,
    failedReasons: unique(
      results
        .filter((item) => item.status === "failed" || item.status === "skipped")
        .map((item) => item.error || "unknown")
    )
  };
}

function writeReport(roundSummaries: RoundSummary[], results: TxResult[]) {
  mkdirSync(dirname(`${reportBase}.json`), { recursive: true });
  const payload = { generatedAt: new Date().toISOString(), summary: roundSummaries, results };
  writeFileSync(`${reportBase}.json`, JSON.stringify(payload, null, 2));

  const workbook = XLSX.utils.book_new();
  const summaryRows = roundSummaries.map((item) => ({
    "并发档位": item.profile,
    "并发数": item.concurrency,
    "轮次": item.round,
    "总数": item.total,
    "成功数": item.confirmed,
    "失败数": item.failed,
    "跳过数": item.skipped,
    "已提交": item.submitted,
    "平均延迟(ms)": item.avgLatencyMs,
    "最大延迟(ms)": item.maxLatencyMs,
    "失败原因": item.failedReasons.join(" | ")
  }));
  const detailRows = results.map((item) => ({
    "并发档位": item.profile,
    "并发数": item.concurrency,
    "轮次": item.round,
    "序号": item.index,
    "钱包地址": item.wallet,
    "状态": item.status,
    "交易哈希": item.hash || "",
    "区块号": item.blockNumber ?? "",
    "Gas": item.gasUsed || "",
    "耗时(ms)": item.durationMs,
    "错误": item.error || ""
  }));

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "轮次汇总");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailRows), "明细");
  try {
    XLSX.writeFile(workbook, `${reportBase}.xlsx`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("EBUSY") || message.includes("resource busy or locked")) {
      const autosavePath = `${reportBase}-autosave.xlsx`;
      XLSX.writeFile(workbook, autosavePath);
      console.log(`Primary workbook locked, wrote autosave copy: ${autosavePath}`);
      return;
    }
    throw error;
  }
}

function loadExistingReport() {
  const path = `${reportBase}.json`;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      summary?: RoundSummary[];
      results?: TxResult[];
    };
    return {
      summary: parsed.summary || [],
      results: parsed.results || []
    };
  } catch {
    return {
      summary: [] as RoundSummary[],
      results: [] as TxResult[]
    };
  }
}

function nextRoundNumber(summary: RoundSummary[], profile: string) {
  const rounds = summary.filter((item) => item.profile === profile).map((item) => item.round);
  if (rounds.length === 0) return 1;
  return Math.max(...rounds) + 1;
}

function parseConcurrencyMatrix(raw?: string) {
  if (!raw) return [] as number[];
  return raw
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrencyLimit: number) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrencyLimit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const taskIndex = next++;
      results[taskIndex] = await tasks[taskIndex]();
    }
  });
  await Promise.all(workers);
  return results;
}

function unique(items: string[]) {
  return [...new Set(items)];
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

import "dotenv/config";
import { Contract, Interface, JsonRpcProvider, Wallet, formatUnits, parseUnits } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

type WalletEntry = {
  index: number;
  address: string;
  privateKey: string;
};

type BuyDetail = {
  sequence: number;
  walletIndex: number;
  wallet: string;
  status: "confirmed" | "failed";
  hash?: string;
  blockNumber?: number;
  transactionIndex?: number;
  gasUsed?: string;
  durationMs: number;
  amountInRaw: string;
  feeRaw?: string;
  reservePartRaw?: string;
  netInForCurveRaw?: string;
  tokensOutRaw?: string;
  finalPriceRaw?: string;
  floorPriceRaw?: string;
  error?: string;
};

const WAD = 10n ** 18n;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`
Usage:
  npm run floor-fee-detail

Optional env:
  FLOOR_FEE_DETAIL_WALLETS           default 10
  FLOOR_FEE_DETAIL_AMOUNT_USDT       default 1000
  FLOOR_FEE_DETAIL_CONCURRENCY       default 5
  FLOOR_FEE_DETAIL_REPORT_BASE       default reports/floor-fee-injection-detail-<timestamp>
`);
  process.exit(0);
}

const rpcUrl = requiredEnv("RPC_URL");
const marketAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const reserveTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const tokenAddress = requiredEnv("REFERRAL_TARGET_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const walletCount = numberEnv("FLOOR_FEE_DETAIL_WALLETS", 10);
const amountUsdt = process.env.FLOOR_FEE_DETAIL_AMOUNT_USDT || "1000";
const concurrency = numberEnv("FLOOR_FEE_DETAIL_CONCURRENCY", 5);
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const reportBase = process.env.FLOOR_FEE_DETAIL_REPORT_BASE || `reports/floor-fee-injection-detail-${runId}`;

const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true, batchMaxCount: 1 });
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function marketState(address token) view returns ((uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice))",
  "function marketInfo(address token) view returns ((address token,address reserveToken,address creator,uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice,uint256 marketLiquidity,uint256 sellMarketDepth,uint256 sellMarketSlope,uint256 buyTargetPrice,uint256 derivedB2,uint256 creatorShare,uint256 reserveShare,bool disableSell))",
  "function buyFee() view returns (uint256)"
];
const erc20Abi = [
  "function decimals() view returns (uint8)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const buyEventAbi = ["event Buy(address indexed token,address indexed buyer,uint256 amountIn,uint256 netInForCurve,uint256 tokensOut,uint256 finalPrice,uint256 floorPrice)"];

const market = new Contract(marketAddress, marketAbi, provider);
const reserveToken = new Contract(reserveTokenAddress, erc20Abi, provider);
const iface = new Interface(buyEventAbi);
const buyTopic = iface.getEvent("Buy").topicHash;

const [reserveDecimalsRaw, marketInfo, marketStateBefore, buyFeeRaw] = await Promise.all([
  reserveToken.decimals(),
  market.marketInfo(tokenAddress),
  market.marketState(tokenAddress),
  market.buyFee()
]);
const reserveDecimals = Number(reserveDecimalsRaw);
const amountInRaw = parseUnits(amountUsdt, reserveDecimals);
const reserveShareRaw = marketInfo.reserveShare as bigint;
const creatorShareRaw = marketInfo.creatorShare as bigint;

const wallets: WalletEntry[] = privateKeys.slice(0, walletCount).map((privateKey, index) => ({
  index,
  address: new Wallet(privateKey).address,
  privateKey
}));

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${marketAddress}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Amount: ${amountUsdt}`);
console.log(`Concurrency: ${concurrency}`);
console.log(`Report base: ${reportBase}`);

const tasks = wallets.map((entry, index) => async () => executeBuy(index, entry, amountInRaw));
const results = await runWithConcurrency(tasks, Math.min(concurrency, wallets.length));
const marketStateAfter = await market.marketState(tokenAddress);
const expectedRows = results.filter((item) => item.status === "confirmed");
const expectedFeeRaw = expectedRows.reduce((sum) => sum + (amountInRaw * buyFeeRaw) / WAD, 0n);
const expectedReservePartRaw = expectedRows.reduce(
  (sum) => sum + (amountInRaw * buyFeeRaw * reserveShareRaw) / WAD / WAD,
  0n
);
const actualReserveDeltaRaw = (marketStateAfter.reserve as bigint) - (marketStateBefore.reserve as bigint);
const actualFloorDeltaRaw = (marketStateAfter.floorPrice as bigint) - (marketStateBefore.floorPrice as bigint);

const summary = {
  generatedAt: new Date().toISOString(),
  walletCount: wallets.length,
  amountUsdt,
  concurrency,
  buyFeeRaw: buyFeeRaw.toString(),
  reserveShareRaw: reserveShareRaw.toString(),
  creatorShareRaw: creatorShareRaw.toString(),
  reserveBeforeRaw: (marketStateBefore.reserve as bigint).toString(),
  reserveAfterRaw: (marketStateAfter.reserve as bigint).toString(),
  reserveDeltaRaw: actualReserveDeltaRaw.toString(),
  floorBeforeRaw: (marketStateBefore.floorPrice as bigint).toString(),
  floorAfterRaw: (marketStateAfter.floorPrice as bigint).toString(),
  floorDeltaRaw: actualFloorDeltaRaw.toString(),
  expectedFeeRaw: expectedFeeRaw.toString(),
  expectedReservePartRaw: expectedReservePartRaw.toString(),
  confirmed: expectedRows.length,
  failed: results.filter((item) => item.status === "failed").length,
  reservePartMatches: actualReserveDeltaRaw === expectedReservePartRaw,
  floorNonDecreasing: (marketStateAfter.floorPrice as bigint) >= (marketStateBefore.floorPrice as bigint)
};

mkdirSync(dirname(`${reportBase}.json`), { recursive: true });
writeFileSync(`${reportBase}.json`, JSON.stringify({ summary, results }, null, 2));

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.json_to_sheet([
    { 字段: "confirmed", 值: summary.confirmed },
    { 字段: "failed", 值: summary.failed },
    { 字段: "buyFee", 值: formatUnits(buyFeeRaw, 18) },
    { 字段: "reserveShare", 值: formatUnits(reserveShareRaw, 18) },
    { 字段: "expectedReservePart", 值: formatUnits(expectedReservePartRaw, reserveDecimals) },
    { 字段: "actualReserveDelta", 值: formatUnits(actualReserveDeltaRaw, reserveDecimals) },
    { 字段: "reservePartMatches", 值: summary.reservePartMatches ? "通过" : "失败" },
    { 字段: "floorBefore", 值: formatUnits(marketStateBefore.floorPrice as bigint, reserveDecimals) },
    { 字段: "floorAfter", 值: formatUnits(marketStateAfter.floorPrice as bigint, reserveDecimals) },
    { 字段: "floorNonDecreasing", 值: summary.floorNonDecreasing ? "通过" : "失败" }
  ]),
  "汇总"
);
XLSX.utils.book_append_sheet(
  workbook,
  XLSX.utils.json_to_sheet(
    results.map((item) => ({
      钱包序号: item.walletIndex,
      钱包地址: item.wallet,
      状态: item.status,
      交易哈希: item.hash || "",
      区块号: item.blockNumber ?? "",
      交易索引: item.transactionIndex ?? "",
      amountIn: formatUnits(BigInt(item.amountInRaw), reserveDecimals),
      fee: item.feeRaw ? formatUnits(BigInt(item.feeRaw), reserveDecimals) : "",
      reservePart: item.reservePartRaw ? formatUnits(BigInt(item.reservePartRaw), reserveDecimals) : "",
      netInForCurve: item.netInForCurveRaw ? formatUnits(BigInt(item.netInForCurveRaw), reserveDecimals) : "",
      tokensOut: item.tokensOutRaw || "",
      finalPrice: item.finalPriceRaw || "",
      floorPrice: item.floorPriceRaw || "",
      Gas: item.gasUsed || "",
      耗时ms: item.durationMs,
      错误: item.error || ""
    }))
  ),
  "明细"
);
XLSX.writeFile(workbook, `${reportBase}.xlsx`);

console.log(JSON.stringify(summary, null, 2));

async function executeBuy(sequence: number, entry: WalletEntry, amountRaw: bigint): Promise<BuyDetail> {
  const startedAt = Date.now();
  const wallet = new Wallet(entry.privateKey, provider);
  const connected = new Contract(marketAddress, marketAbi, wallet);
  try {
    const tx = await connected.buy(tokenAddress, amountRaw, 0, Math.floor(Date.now() / 1000) + deadlineSeconds);
    const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
    if (receipt?.status !== 1) {
      return {
        sequence,
        walletIndex: entry.index,
        wallet: entry.address,
        status: "failed",
        hash: tx.hash,
        blockNumber: receipt?.blockNumber,
        transactionIndex: receipt?.index,
        gasUsed: receipt?.gasUsed?.toString(),
        durationMs: Date.now() - startedAt,
        amountInRaw: amountRaw.toString(),
        error: `tx reverted: ${tx.hash}`
      };
    }

    const parsed = receipt.logs
      .filter((log) => log.address.toLowerCase() === marketAddress.toLowerCase() && log.topics[0]?.toLowerCase() === buyTopic.toLowerCase())
      .map((log) => iface.parseLog({ topics: [...log.topics], data: log.data }))[0];

    const amountInEvent = parsed?.args[2] as bigint | undefined;
    const netInForCurve = parsed?.args[3] as bigint | undefined;
    const tokensOut = parsed?.args[4] as bigint | undefined;
    const finalPrice = parsed?.args[5] as bigint | undefined;
    const floorPrice = parsed?.args[6] as bigint | undefined;
    const feeRaw = amountInEvent && netInForCurve ? amountInEvent - netInForCurve : undefined;
    const reservePartRaw = feeRaw !== undefined ? (feeRaw * reserveShareRaw) / WAD : undefined;

    return {
      sequence,
      walletIndex: entry.index,
      wallet: entry.address,
      status: "confirmed",
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      transactionIndex: receipt.index,
      gasUsed: receipt.gasUsed?.toString(),
      durationMs: Date.now() - startedAt,
      amountInRaw: amountRaw.toString(),
      feeRaw: feeRaw?.toString(),
      reservePartRaw: reservePartRaw?.toString(),
      netInForCurveRaw: netInForCurve?.toString(),
      tokensOutRaw: tokensOut?.toString(),
      finalPriceRaw: finalPrice?.toString(),
      floorPriceRaw: floorPrice?.toString()
    };
  } catch (error) {
    return {
      sequence,
      walletIndex: entry.index,
      wallet: entry.address,
      status: "failed",
      durationMs: Date.now() - startedAt,
      amountInRaw: amountRaw.toString(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
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

import "dotenv/config";
import {
  Contract,
  JsonRpcProvider,
  MaxUint256,
  Wallet,
  formatUnits,
  parseUnits
} from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Action = "buy" | "sell";

type PlannedAction = {
  sequence: number;
  action: Action;
  walletIndex: number;
};

type TradeResult = {
  sequence: number;
  action: Action;
  walletIndex: number;
  wallet: string;
  status: "submitted" | "confirmed" | "failed" | "skipped";
  amountIn: string;
  expectedOut?: string;
  minAmountOut: string;
  hash?: string;
  blockNumber?: number;
  gasUsed?: string;
  scheduledAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  durationMs: number;
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const marketContractAddress = requiredEnv("BUY_CONTRACT_ADDRESS");
const paymentTokenAddress = requiredEnv("PAYMENT_TOKEN_ADDRESS");
const tokenAddress = requiredEnv("HOUR_TRADE_TOKEN_ADDRESS");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);

const walletCount = numberEnv("HOUR_TRADE_WALLETS", 100);
const buyCount = numberEnv("HOUR_TRADE_BUY_COUNT", 200);
const sellCount = numberEnv("HOUR_TRADE_SELL_COUNT", 200);
const durationMs = numberEnv("HOUR_TRADE_DURATION_MS", 3_600_000);
const buyAmount = parseUnits(process.env.HOUR_TRADE_BUY_AMOUNT_U || "1000", 18);
const sellTargetOut = parseUnits(process.env.HOUR_TRADE_SELL_TARGET_U || "1000", 18);
const sellMinOutBps = BigInt(numberEnv("HOUR_TRADE_SELL_MIN_OUT_BPS", 0));
const planMode = process.env.HOUR_TRADE_PLAN_MODE || "staggered";
const receiptTimeoutMs = numberEnv("RECEIPT_TIMEOUT_MS", 180_000);
const deadlineSeconds = numberEnv("DEADLINE_SECONDS", 3600);
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const approvalConcurrency = numberEnv("HOUR_TRADE_APPROVAL_CONCURRENCY", 12);
const reportPath =
  process.env.HOUR_TRADE_REPORT_PATH ||
  `reports/hourly-balanced-trade-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;

const provider = new JsonRpcProvider(rpcUrl);
const wallets = privateKeys.slice(0, walletCount).map((key) => new Wallet(key, provider));
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minTokensOut,uint256 deadline) returns (uint256 tokensOut)",
  "function sell(address token,uint256 tokensIn,uint256 minAmountOut,uint256 deadline) returns (uint256 amountOut)",
  "function quoteBuyExactIn(address token,uint256 amountIn) view returns (uint256 tokensOut,uint256 finalPrice,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee)",
  "function quoteSellExactIn(address token,uint256 tokensIn) view returns (uint256 amountOut,uint256 grossOut,uint256 finalPrice,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee)"
];
const erc20Abi = [
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];
const market = new Contract(marketContractAddress, marketAbi, provider);
const paymentToken = new Contract(paymentTokenAddress, erc20Abi, provider);
const tradeToken = new Contract(tokenAddress, erc20Abi, provider);

if (wallets.length === 0) throw new Error("No wallets loaded from PRIVATE_KEYS.");
if (buyCount % wallets.length !== 0 || sellCount % wallets.length !== 0) {
  console.log("Warning: buy/sell counts are not exact multiples of wallet count; wallet rotation will wrap.");
}

const totalActions = buyCount + sellCount;
const intervalMs = Math.floor(durationMs / totalActions);
const plan = buildPlan();
const results: TradeResult[] = [];
const receiptPromises: Array<Promise<void>> = [];

console.log(`RPC: ${rpcUrl}`);
console.log(`Market: ${marketContractAddress}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Payment token: ${paymentTokenAddress}`);
console.log(`Wallets: ${wallets.length}`);
console.log(`Buy count: ${buyCount}, sell count: ${sellCount}`);
console.log(`Buy amount: ${formatUnits(buyAmount, 18)} U`);
console.log(`Sell target: ${formatUnits(sellTargetOut, 18)} U`);
console.log(`Plan mode: ${planMode}`);
console.log(`Interval: ${intervalMs}ms`);
console.log(`Report: ${reportPath}`);

await prepareApprovals();
writeReport();

const startedAt = Date.now();
for (const item of plan) {
  const scheduledTime = startedAt + item.sequence * intervalMs;
  const waitMs = scheduledTime - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  const result = await submitPlannedAction(item, scheduledTime);
  results[item.sequence] = result;
  writeReport();
}

console.log("All planned transactions submitted. Waiting for remaining receipts...");
await Promise.allSettled(receiptPromises);
writeReport();
console.log(JSON.stringify(summaryData(), null, 2));

async function prepareApprovals() {
  console.log("Preparing approvals only where allowance is insufficient...");
  const usdtNeeded = buyAmount * BigInt(Math.ceil(buyCount / wallets.length));
  const tasks = wallets.map((wallet, index) => async () => {
    const reserve = new Contract(paymentTokenAddress, erc20Abi, wallet);
    const token = new Contract(tokenAddress, erc20Abi, wallet);
    await approveIfNeeded(index, reserve, wallet.address, usdtNeeded, "USDT");
    await approveIfNeeded(index, token, wallet.address, MaxUint256, "trade token");
  });
  await runWithConcurrency(tasks, approvalConcurrency);
}

async function approveIfNeeded(
  index: number,
  token: Contract,
  owner: string,
  amount: bigint,
  label: string
) {
  const allowance = await token.allowance(owner, marketContractAddress);
  if (allowance >= amount) {
    console.log(`#${index} ${label} allowance OK`);
    return;
  }

  const tx = await token.approve(marketContractAddress, amount);
  console.log(`#${index} ${label} approve tx: ${tx.hash}`);
  const receipt = await waitWithTimeout(tx.wait(), receiptTimeoutMs);
  if (receipt?.status !== 1) throw new Error(`#${index} ${label} approve failed: ${tx.hash}`);
}

async function submitPlannedAction(item: PlannedAction, scheduledTime: number): Promise<TradeResult> {
  const startedAt = Date.now();
  const wallet = wallets[item.walletIndex];
  const connectedMarket = market.connect(wallet) as Contract;
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;

  try {
    const ethBalance = await provider.getBalance(wallet.address);
    if (ethBalance < minEthWei) {
      return skipped(item, wallet, scheduledTime, startedAt, "Insufficient ETH for gas", "0", "0");
    }

    if (item.action === "buy") {
      const balance = await paymentToken.balanceOf(wallet.address);
      if (balance < buyAmount) {
        return skipped(item, wallet, scheduledTime, startedAt, "Insufficient USDT", buyAmount.toString(), "0");
      }

      const quote = await market.quoteBuyExactIn(tokenAddress, buyAmount);
      const tx = await connectedMarket.buy(tokenAddress, buyAmount, 0, deadline);
      console.log(
        `#${item.sequence + 1}/${totalActions} BUY wallet #${item.walletIndex} ${wallet.address} tx=${tx.hash}`
      );
      const result: TradeResult = {
        sequence: item.sequence,
        action: item.action,
        walletIndex: item.walletIndex,
        wallet: wallet.address,
        status: "submitted",
        amountIn: buyAmount.toString(),
        expectedOut: quote[0].toString(),
        minAmountOut: "0",
        hash: tx.hash,
        scheduledAt: new Date(scheduledTime).toISOString(),
        submittedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt
      };
      trackReceipt(result, tx.wait());
      return result;
    }

    const tokenBalance = await tradeToken.balanceOf(wallet.address);
    if (tokenBalance <= 0n) {
      return skipped(item, wallet, scheduledTime, startedAt, "No sellable token balance", "0", "0");
    }

    const { tokensIn, expectedOut } = await computeSellAmountForTarget(tokenBalance);
    if (tokensIn <= 0n) {
      return skipped(item, wallet, scheduledTime, startedAt, "Unable to compute sell amount", "0", "0");
    }

    const minOut = sellMinOutBps > 0n ? (expectedOut * sellMinOutBps) / 10_000n : 0n;
    const tx = await connectedMarket.sell(tokenAddress, tokensIn, minOut, deadline);
    console.log(
      `#${item.sequence + 1}/${totalActions} SELL wallet #${item.walletIndex} ${wallet.address} ` +
        `tokens=${formatUnits(tokensIn, 18)} expectedU=${formatUnits(expectedOut, 18)} tx=${tx.hash}`
    );
    const result: TradeResult = {
      sequence: item.sequence,
      action: item.action,
      walletIndex: item.walletIndex,
      wallet: wallet.address,
      status: "submitted",
      amountIn: tokensIn.toString(),
      expectedOut: expectedOut.toString(),
      minAmountOut: minOut.toString(),
      hash: tx.hash,
      scheduledAt: new Date(scheduledTime).toISOString(),
      submittedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt
    };
    trackReceipt(result, tx.wait());
    return result;
  } catch (error) {
    return {
      sequence: item.sequence,
      action: item.action,
      walletIndex: item.walletIndex,
      wallet: wallet.address,
      status: "failed",
      amountIn: "0",
      minAmountOut: "0",
      scheduledAt: new Date(scheduledTime).toISOString(),
      submittedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function computeSellAmountForTarget(balance: bigint) {
  const quoteBalance = await market.quoteSellExactIn(tokenAddress, balance);
  const maxOut = quoteBalance[0] as bigint;
  if (maxOut <= sellTargetOut) {
    return { tokensIn: balance, expectedOut: maxOut };
  }

  let low = 1n;
  let high = balance;
  let best = balance;
  let bestOut = maxOut;

  for (let i = 0; i < 32; i++) {
    const mid = (low + high) / 2n;
    const quote = await market.quoteSellExactIn(tokenAddress, mid);
    const out = quote[0] as bigint;

    if (out >= sellTargetOut) {
      best = mid;
      bestOut = out;
      high = mid - 1n;
    } else {
      low = mid + 1n;
    }
  }

  return { tokensIn: best, expectedOut: bestOut };
}

function trackReceipt(result: TradeResult, receiptPromise: Promise<unknown>) {
  const promise = waitWithTimeout(receiptPromise, receiptTimeoutMs)
    .then((receipt: any) => {
      result.status = receipt?.status === 1 ? "confirmed" : "failed";
      result.blockNumber = receipt?.blockNumber;
      result.gasUsed = receipt?.gasUsed?.toString();
      result.confirmedAt = new Date().toISOString();
      writeReport();
    })
    .catch((error) => {
      result.status = "failed";
      result.error = error instanceof Error ? error.message : String(error);
      result.confirmedAt = new Date().toISOString();
      writeReport();
    });
  receiptPromises.push(promise);
}

function skipped(
  item: PlannedAction,
  wallet: Wallet,
  scheduledTime: number,
  startedAt: number,
  error: string,
  amountIn: string,
  minAmountOut: string
): TradeResult {
  console.log(`#${item.sequence + 1}/${totalActions} ${item.action.toUpperCase()} wallet #${item.walletIndex} skipped: ${error}`);
  return {
    sequence: item.sequence,
    action: item.action,
    walletIndex: item.walletIndex,
    wallet: wallet.address,
    status: "skipped",
    amountIn,
    minAmountOut,
    scheduledAt: new Date(scheduledTime).toISOString(),
    submittedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    error
  };
}

function buildPlan(): PlannedAction[] {
  const actions: Array<Omit<PlannedAction, "sequence">> = [];

  if (planMode === "staggered") {
    if (buyCount > 0) {
      actions.push({ action: "buy", walletIndex: 0 % wallets.length });
    }

    for (let i = 1; i < buyCount; i++) {
      actions.push({ action: "buy", walletIndex: i % wallets.length });
      if (i - 1 < sellCount) {
        actions.push({ action: "sell", walletIndex: (i - 1) % wallets.length });
      }
    }

    for (let i = Math.max(0, buyCount - 1); i < sellCount; i++) {
      actions.push({ action: "sell", walletIndex: i % wallets.length });
    }

    return actions.map((action, sequence) => ({ sequence, ...action }));
  }

  for (let i = 0; i < buyCount; i++) {
    actions.push({ action: "buy", walletIndex: i % wallets.length });
  }
  for (let i = 0; i < sellCount; i++) {
    actions.push({ action: "sell", walletIndex: i % wallets.length });
  }
  return actions.map((action, sequence) => ({ sequence, ...action }));
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

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        config: {
          marketContractAddress,
          tokenAddress,
          paymentTokenAddress,
          walletCount: wallets.length,
          buyCount,
          sellCount,
          durationMs,
          intervalMs,
          buyAmount: buyAmount.toString(),
          sellTargetOut: sellTargetOut.toString()
        },
        summary: summaryData(),
        results: results.filter(Boolean)
      },
      null,
      2
    )
  );
}

function summaryData() {
  const present = results.filter(Boolean);
  return {
    totalPlanned: totalActions,
    recorded: present.length,
    buyRecorded: present.filter((result) => result.action === "buy").length,
    sellRecorded: present.filter((result) => result.action === "sell").length,
    submitted: present.filter((result) => result.status === "submitted").length,
    confirmed: present.filter((result) => result.status === "confirmed").length,
    skipped: present.filter((result) => result.status === "skipped").length,
    failed: present.filter((result) => result.status === "failed").length
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

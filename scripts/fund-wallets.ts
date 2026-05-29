import "dotenv/config";
import {
  Contract,
  formatEther,
  JsonRpcProvider,
  NonceManager,
  parseEther,
  Wallet
} from "ethers";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type GeneratedWallet = {
  index: number;
  address: string;
  privateKey: string;
};

type FundResult = {
  index: number;
  address: string;
  ethTxHash?: string;
  tokenTxHash?: string;
  status: "funded" | "failed";
  error?: string;
};

const rpcUrl = requiredEnv("RPC_URL");
const fundingPrivateKey = requiredEnv("FUNDING_PRIVATE_KEY");
const walletsPath = process.env.GENERATED_WALLETS_PATH || "wallets/generated-wallets.json";
const paymentTokenAddress = process.env.PAYMENT_TOKEN_ADDRESS;
const ethPerWallet = process.env.FUND_ETH_PER_WALLET || "0";
const ethTargetPerWallet = process.env.FUND_ETH_TARGET_PER_WALLET
  ? parseEther(process.env.FUND_ETH_TARGET_PER_WALLET)
  : undefined;
const tokenAmountPerWallet = process.env.FUND_TOKEN_AMOUNT_PER_WALLET || "0";
const tokenTargetPerWallet = process.env.FUND_TOKEN_TARGET_PER_WALLET
  ? BigInt(process.env.FUND_TOKEN_TARGET_PER_WALLET)
  : undefined;
const maxConcurrency = numberEnv("FUND_MAX_CONCURRENCY", 1);
const waitForReceipt = (process.env.FUND_WAIT_FOR_RECEIPT || "true").toLowerCase() === "true";
const reportPath = process.env.FUND_REPORT_PATH || "reports/fund-wallets-report.json";

const recipients = JSON.parse(readFileSync(walletsPath, "utf8")) as GeneratedWallet[];
const provider = new JsonRpcProvider(rpcUrl, undefined, {
  staticNetwork: true
});
const fundingWallet = new Wallet(fundingPrivateKey, provider);
const signer = new NonceManager(fundingWallet);
const ethValue = parseEther(ethPerWallet);
const tokenAmount = BigInt(tokenAmountPerWallet);
const erc20 = paymentTokenAddress
  ? new Contract(
      paymentTokenAddress,
      [
        "function balanceOf(address owner) view returns (uint256)",
        "function transfer(address to,uint256 amount) returns (bool)"
      ],
      signer
    )
  : undefined;

console.log(`Funding wallet: ${fundingWallet.address}`);
console.log(`Recipients: ${recipients.length}`);
console.log(`ETH per wallet: ${ethPerWallet}`);
console.log(`ETH target per wallet: ${ethTargetPerWallet ? formatEther(ethTargetPerWallet) : "disabled"}`);
console.log(`Payment token: ${paymentTokenAddress || "disabled"}`);
console.log(`Token amount per wallet: ${tokenAmount.toString()}`);
console.log(`Token target per wallet: ${tokenTargetPerWallet?.toString() || "disabled"}`);
console.log(`Max concurrency: ${maxConcurrency}`);
console.log(`Wait for receipt: ${waitForReceipt}`);

await assertFundingBalances();

const tasks = recipients.map((recipient) => async () => fundRecipient(recipient));
const results = await runWithConcurrency(tasks, maxConcurrency);

writeReport(results);
console.log(summary(results));

async function assertFundingBalances() {
  console.log("Checking funding wallet ETH balance...");
  const neededEth = ethTargetPerWallet
    ? await getNeededTopUpEthTotal()
    : ethValue * BigInt(recipients.length);
  const currentEth = await withTimeout(
    provider.getBalance(fundingWallet.address),
    30_000,
    "Timed out checking funding wallet ETH balance"
  );

  console.log(`Funding wallet ETH balance: ${formatEther(currentEth)}`);

  if (ethValue > 0n && currentEth < neededEth) {
    throw new Error(
      `Funding wallet has ${formatEther(currentEth)} ETH, needs at least ${formatEther(neededEth)} ETH plus gas.`
    );
  }

  if (erc20 && tokenAmount > 0n) {
    console.log("Checking funding wallet payment token balance...");
    const neededToken = tokenTargetPerWallet
      ? await getNeededTopUpTokenTotal()
      : tokenAmount * BigInt(recipients.length);
    const currentToken = await withTimeout(
      erc20.balanceOf(fundingWallet.address),
      30_000,
      "Timed out checking funding wallet payment token balance"
    );

    console.log(`Funding wallet payment token balance: ${currentToken.toString()}`);

    if (currentToken < neededToken) {
      throw new Error(
        `Funding wallet has ${currentToken.toString()} payment token, needs ${neededToken.toString()}.`
      );
    }
  }
}

async function fundRecipient(recipient: GeneratedWallet): Promise<FundResult> {
  try {
    console.log(`Funding #${recipient.index} ${recipient.address}`);
    const result: FundResult = {
      index: recipient.index,
      address: recipient.address,
      status: "funded"
    };

    if (ethValue > 0n) {
      const transferEth = await getEthTransferAmount(recipient.address);
      if (transferEth === 0n) {
        console.log(`  ETH #${recipient.index}: already at target`);
      } else {
        console.log(`  Sending ETH to #${recipient.index}: ${formatEther(transferEth)}`);
      const tx = await signer.sendTransaction({
        to: recipient.address,
          value: transferEth
      });
      console.log(`  ETH tx #${recipient.index}: ${tx.hash}`);
      if (waitForReceipt) {
        const receipt = await withTimeout(tx.wait(), 180_000, `Timed out waiting ETH tx ${tx.hash}`);
        if (receipt?.status !== 1) throw new Error(`ETH transfer failed: ${tx.hash}`);
      }
      result.ethTxHash = tx.hash;
      }
    }

    if (erc20 && tokenAmount > 0n) {
      const transferAmount = await getTokenTransferAmount(recipient.address);
      if (transferAmount === 0n) {
        console.log(`  Payment token #${recipient.index}: already at target`);
        return result;
      }

      console.log(`  Sending payment token to #${recipient.index}: ${transferAmount.toString()}`);
      const tx = await erc20.transfer(recipient.address, transferAmount);
      console.log(`  Token tx #${recipient.index}: ${tx.hash}`);
      if (waitForReceipt) {
        const receipt = await withTimeout(tx.wait(), 180_000, `Timed out waiting token tx ${tx.hash}`);
        if (receipt?.status !== 1) throw new Error(`Token transfer failed: ${tx.hash}`);
      }
      result.tokenTxHash = tx.hash;
    }

    return result;
  } catch (error) {
    return {
      index: recipient.index,
      address: recipient.address,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function getNeededTopUpEthTotal() {
  if (!ethTargetPerWallet) return 0n;

  let total = 0n;
  for (const recipient of recipients) {
    total += await getEthTransferAmount(recipient.address);
  }

  return total;
}

async function getEthTransferAmount(address: string) {
  if (!ethTargetPerWallet) return ethValue;

  const current = await provider.getBalance(address);
  if (current >= ethTargetPerWallet) return 0n;
  return ethTargetPerWallet - current;
}

async function getNeededTopUpTokenTotal() {
  if (!erc20 || !tokenTargetPerWallet) return 0n;

  let total = 0n;
  for (const recipient of recipients) {
    total += await getTokenTransferAmount(recipient.address);
  }

  return total;
}

async function getTokenTransferAmount(address: string) {
  if (!erc20) return 0n;
  if (!tokenTargetPerWallet) return tokenAmount;

  const current = await erc20.balanceOf(address);
  if (current >= tokenTargetPerWallet) return 0n;
  return tokenTargetPerWallet - current;
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

function writeReport(results: FundResult[]) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ summary: summaryData(results), results }, null, 2));
  console.log(`Fund report written to ${reportPath}`);
}

function summary(results: FundResult[]) {
  return JSON.stringify(summaryData(results), null, 2);
}

function summaryData(results: FundResult[]) {
  return {
    total: results.length,
    funded: results.filter((result) => result.status === "funded").length,
    failed: results.filter((result) => result.status === "failed").length
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
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

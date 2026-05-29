import "dotenv/config";
import { Contract, formatEther, JsonRpcProvider, Wallet } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type BalanceRow = {
  index: number;
  address: string;
  ethWei: string;
  eth: string;
  paymentTokenRaw?: string;
  hasEnoughEth: boolean;
  hasEnoughPaymentToken?: boolean;
};

const rpcUrl = requiredEnv("RPC_URL");
const privateKeys = requiredEnv("PRIVATE_KEYS")
  .split(",")
  .map((key) => key.trim())
  .filter(Boolean);
const paymentTokenAddress = process.env.PAYMENT_TOKEN_ADDRESS;
const approveAmount = process.env.APPROVE_AMOUNT ? BigInt(process.env.APPROVE_AMOUNT) : undefined;
const minEthWei = BigInt(process.env.MIN_ETH_WEI || "1000000000000000");
const reportPath = process.env.BALANCE_REPORT_PATH || "reports/balances.json";

const provider = new JsonRpcProvider(rpcUrl);
const erc20 = paymentTokenAddress
  ? new Contract(paymentTokenAddress, ["function balanceOf(address owner) view returns (uint256)"], provider)
  : undefined;

const wallets = privateKeys.map((key) => new Wallet(key));
const rows: BalanceRow[] = [];

for (let i = 0; i < wallets.length; i++) {
  const wallet = wallets[i];
  const ethWei = await provider.getBalance(wallet.address);
  const row: BalanceRow = {
    index: i,
    address: wallet.address,
    ethWei: ethWei.toString(),
    eth: formatEther(ethWei),
    hasEnoughEth: ethWei >= minEthWei
  };

  if (erc20 && approveAmount !== undefined) {
    const paymentTokenRaw = await erc20.balanceOf(wallet.address);
    row.paymentTokenRaw = paymentTokenRaw.toString();
    row.hasEnoughPaymentToken = paymentTokenRaw >= approveAmount;
  }

  rows.push(row);
}

const summary = {
  total: rows.length,
  minEthWei: minEthWei.toString(),
  enoughEth: rows.filter((row) => row.hasEnoughEth).length,
  enoughPaymentToken: erc20
    ? rows.filter((row) => row.hasEnoughPaymentToken).length
    : undefined,
  missingEth: rows.filter((row) => !row.hasEnoughEth).map((row) => row.address),
  missingPaymentToken: erc20
    ? rows.filter((row) => !row.hasEnoughPaymentToken).map((row) => row.address)
    : undefined
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ summary, rows }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log(`Balance report written to ${reportPath}`);

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

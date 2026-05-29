import "dotenv/config";
import { JsonRpcProvider } from "ethers";

const txHash = process.argv[2];
const rpcUrl = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

if (!txHash) {
  throw new Error("Usage: npm run inspect-tx -- 0xTransactionHash");
}

const provider = new JsonRpcProvider(rpcUrl);
const tx = await provider.getTransaction(txHash);
const receipt = await provider.getTransactionReceipt(txHash);

if (!tx || !receipt) {
  throw new Error(`Transaction not found: ${txHash}`);
}

const selector = tx.data.slice(0, 10);
const calldataWords = tx.data
  .slice(10)
  .match(/.{1,64}/g)
  ?.map((word, index) => ({ index, word: `0x${word}` })) ?? [];

const erc20Transfers = receipt.logs
  .filter((log) => log.topics[0]?.toLowerCase() === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")
  .map((log) => ({
    token: log.address,
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
    amountRaw: BigInt(log.data).toString()
  }));

console.log(JSON.stringify({
  hash: tx.hash,
  status: receipt.status,
  chainId: tx.chainId?.toString(),
  from: tx.from,
  to: tx.to,
  valueWei: tx.value.toString(),
  valueEthHint: `${Number(tx.value) / 1e18}`,
  selector,
  calldataWords,
  erc20Transfers,
  logAddresses: [...new Set(receipt.logs.map((log) => log.address))]
}, null, 2));

function topicToAddress(topic?: string) {
  if (!topic) return null;
  return `0x${topic.slice(-40)}`;
}

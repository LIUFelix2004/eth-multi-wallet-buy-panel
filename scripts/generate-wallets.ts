import { Wallet } from "ethers";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const walletCount = numberArg("--count", 100);
const outputPath = stringArg("--out", "wallets/generated-wallets.json");
const envOutputPath = stringArg("--env-out", "wallets/private-keys.env");

const wallets = Array.from({ length: walletCount }, (_, index) => {
  const wallet = Wallet.createRandom();

  return {
    index,
    address: wallet.address,
    privateKey: wallet.privateKey,
    mnemonic: wallet.mnemonic?.phrase
  };
});

writeJson(outputPath, wallets);
writeText(envOutputPath, `PRIVATE_KEYS=${wallets.map((wallet) => wallet.privateKey).join(",")}\n`);

console.log(`Generated ${wallets.length} wallets.`);
console.log(`Wallet JSON: ${outputPath}`);
console.log(`PRIVATE_KEYS env file: ${envOutputPath}`);
console.log("");
console.log("Fund these addresses with Sepolia ETH before running npm run buy:");
console.log(wallets.map((wallet) => wallet.address).join("\n"));
console.log("");
console.log("Keep the generated files private. They contain test wallet private keys.");

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function numberArg(name: string, fallback: number) {
  const value = stringArg(name);
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }

  return parsed;
}

function stringArg(name: string, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }

  return value;
}

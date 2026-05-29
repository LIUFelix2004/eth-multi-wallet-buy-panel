import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type GeneratedWallet = {
  index: number;
  address: string;
  privateKey: string;
};

const inputPath = stringArg("--in", "wallets/generated-wallets.json");
const txtOutputPath = stringArg("--txt-out", "wallets/addresses.txt");
const jsonOutputPath = stringArg("--json-out", "wallets/addresses.json");
const remixOutputPath = stringArg("--remix-out", "wallets/addresses-remix.txt");

const wallets = JSON.parse(readFileSync(inputPath, "utf8")) as GeneratedWallet[];
const addresses = wallets.map((wallet) => wallet.address);

writeText(txtOutputPath, `${addresses.join("\n")}\n`);
writeText(jsonOutputPath, `${JSON.stringify(addresses, null, 2)}\n`);
writeText(remixOutputPath, `[${addresses.map((address) => `"${address}"`).join(",")}]\n`);

console.log(`Exported ${addresses.length} addresses.`);
console.log(`Plain text: ${txtOutputPath}`);
console.log(`JSON: ${jsonOutputPath}`);
console.log(`Remix argument: ${remixOutputPath}`);

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
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

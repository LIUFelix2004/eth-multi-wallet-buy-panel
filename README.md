# Sepolia Multi-Wallet Buy Test

Use this from the computer that cannot log in to the internal frontend, as long as it can reach Sepolia RPC and the buy contract is publicly callable.

The other computer only needs to create the token and send you the on-chain details.

## What You Need From The Other Computer

- Sepolia chain ID, normally `11155111`
- Token address
- Buy contract address, such as launchpad/router/bonding-curve contract
- Buy function signature
- Required buy arguments

Examples:

```text
Buy contract: 0xRouter...
Function: buy(address token,uint256 minTokensOut) payable
Args: ["0xToken...", "0"]
Value: 0.001 ETH
```

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env`.

```bash
copy .env.example .env
```

Fill these:

```bash
RPC_URL=https://sepolia.infura.io/v3/YOUR_KEY
BUY_CONTRACT_ADDRESS=0xRouterOrCurveContract
BUY_FUNCTION_SIGNATURE=function buy(address token,uint256 minTokensOut) payable
BUY_ARGS_JSON=["0xTokenAddress","0"]
BUY_VALUE_ETH=0.001
PRIVATE_KEYS=0xWallet1PrivateKey,0xWallet2PrivateKey
TOTAL_BUYS=100
MAX_CONCURRENCY=20
```

If the buy function spends an ERC20 token, also set:

```bash
PAYMENT_TOKEN_ADDRESS=0xPaymentToken
APPROVE_AMOUNT=100000000000000000000
BUY_VALUE_ETH=0
```

Use only funded Sepolia test wallets. Never use mainnet private keys.

## Generate 100 Test Wallets

To create 100 fresh EVM wallets:

```bash
npm run generate-wallets
```

This writes:

```text
wallets/generated-wallets.json
wallets/private-keys.env
```

Copy the `PRIVATE_KEYS=...` line from `wallets/private-keys.env` into `.env`.

Then fund the generated addresses with Sepolia ETH before running the buy test.

You can also choose a different count:

```bash
npm run generate-wallets -- --count 100
```

## Export Addresses For Batch Funding

```bash
npm run export-addresses
```

This writes:

```text
wallets/addresses.txt
wallets/addresses.json
wallets/addresses-remix.txt
```

Use `wallets/addresses-remix.txt` if you fund through Remix and the included `contracts/BatchEthSender.sol`.

## Run

Before buying, check whether every wallet has enough Sepolia ETH and payment token:

```bash
npm run check-balances
```

To fund all generated wallets from one Sepolia test wallet, set these in `.env`:

```bash
FUNDING_PRIVATE_KEY=0xYourSepoliaFundingPrivateKey
FUND_ETH_PER_WALLET=0.002
FUND_TOKEN_AMOUNT_PER_WALLET=100000000000000000000
```

Then run:

```bash
npm run fund-wallets
npm run check-balances
```

```bash
npm run buy
```

The report is written to:

```text
reports/multi-buy-report.json
```

## Market Maker Panel

For a local control panel that manages multiple wallets and launches real batch buy/sell or random market-making jobs:

```bash
npm run panel
```

Then open:

```text
http://127.0.0.1:3210
```

Recommended workflow:

- fill in RPC, market contract, token address, reserve token address
- import wallets by pasting private keys, or load `wallets/generated-wallets.json`
- create wallet groups and label important wallets before mainnet operation
- refresh balances to confirm gas and reserve inventory
- select specific wallets or filter by group before launching jobs
- set risk thresholds such as max wallets, min retained balances, and failure stop limits
- start batch buy, batch sell, or random market-making jobs from the UI
- use the stop button to cancel new submissions if execution needs to be halted

Notes:

- the panel runs locally and stores wallet config in `panel-data/state.json`
- only one job can run at a time to avoid nonce and balance conflicts across the same wallet pool
- each finished job is written to `reports/panel-job-<jobId>.json`

## Deploy To Railway

This project is a long-running Node.js control panel with:

- local wallet/state persistence
- long-running batch jobs
- in-memory job logs

So it should be deployed to a persistent Node host such as Railway, not Vercel.

### 1. Push The Project To GitHub

Make sure these are **not** committed:

- `.env`
- `panel-data/`
- `reports/`
- generated private key files under `wallets/`

A `.gitignore` is included for this.

### 2. Create A Railway Project

In Railway:

- create a new project
- choose `Deploy from GitHub repo`
- select this repository

Railway will detect `railway.json` and start the app with:

```bash
npm run panel
```

### 3. Add Environment Variables

At minimum, configure these in Railway:

```bash
RPC_URL=...
PRIVATE_KEYS=0x...,0x...
BUY_CONTRACT_ADDRESS=0x...
PAYMENT_TOKEN_ADDRESS=0x...
PANEL_PORT=3210
```

Recommended panel-related variables:

```bash
DEADLINE_SECONDS=600
RECEIPT_TIMEOUT_MS=180000
MAX_CONCURRENCY=10
MIN_ETH_WEI=1000000000000000
RANDOM_TRADE_BUY_AMOUNT=1000000000000000000
RANDOM_TRADE_MAX_SELL_AMOUNT=1000000000000000000
RANDOM_TRADE_INTERVAL_MS=60000
RANDOM_TRADE_WALLETS_PER_ROUND=20
RANDOM_TRADE_MAX_CONCURRENCY=5
RANDOM_TRADE_BUY_PROBABILITY_BPS=5000
RANDOM_TRADE_RESERVE_KEEP_AMOUNT=0
RANDOM_TRADE_TOKEN_KEEP_AMOUNT=0
RANDOM_TRADE_SELL_DIVISOR=5
```

### 4. Add Persistent Volume

If your Railway UI only allows a single volume, that is fine.

Create one volume and mount it to:

```text
/app/runtime-data
```

Then add these extra environment variables:

```bash
RUNTIME_DATA_ROOT=/app/runtime-data
```

This will automatically store:

- panel state in `/app/runtime-data/panel-data`
- reports in `/app/runtime-data/reports`
- wallet files in `/app/runtime-data/wallets`

Without persistent storage:

- panel state will reset on redeploy
- job reports will disappear
- imported/generated wallet files may be lost

### 5. Open The Panel

After deploy, open the Railway public URL.

The server health endpoint is:

```text
/api/state
```

If deployment succeeds, the main panel UI should be reachable from the root path:

```text
/
```

### 6. Operational Notes

- this app keeps active job state in memory, so an in-progress job will not survive a container restart
- finished job reports are saved under `reports/` if persistent storage is mounted
- only run one live instance of the panel against the same wallet pool, otherwise nonce and balance conflicts can occur
- never deploy with mainnet private keys unless you fully understand the operational risk

## Important Limits

This is not a frontend test. It is a chain-level multi-wallet buy test.

It works if users can buy by calling the contract directly.

It will not work if your system requires:

- internal frontend login before every buy
- a backend-generated signature
- captcha
- server-side whitelist
- wallet session bound to the internal computer

If the buy function requires ERC20 payment instead of ETH, you need an approval step before the buy call.

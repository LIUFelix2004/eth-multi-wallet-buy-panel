import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatUnits, isAddress } from "ethers";

type WalletRecord = {
  id: string;
  privateKey: string;
  enabled: boolean;
  label: string;
  groups: string[];
  notes: string;
  createdAt: string;
};

type RiskControls = {
  maxWalletsPerTask: number;
  maxAmountWeiPerOrder: string;
  minNativeBalanceWei: string;
  minReserveBalanceWei: string;
  minTokenBalanceWei: string;
  minReserveLeftWei: string;
  minTokenLeftWei: string;
  stopOnTotalFailures: number;
  stopOnConsecutiveFailures: number;
};

type PanelConfig = {
  rpcUrl: string;
  marketContractAddress: string;
  tokenAddress: string;
  reserveTokenAddress: string;
  deadlineSeconds: number;
  receiptTimeoutMs: number;
  defaultMaxConcurrency: number;
  buyAmount: string;
  sellAmount: string;
  randomRounds: number;
  randomIntervalMs: number;
  randomWalletsPerRound: number;
  randomMaxConcurrency: number;
  randomBuyProbabilityBps: number;
  randomReserveKeepAmount: string;
  randomTokenKeepAmount: string;
  randomMaxSellAmount: string;
  randomSellDivisor: number;
  riskControls: RiskControls;
};

type PanelState = {
  config: PanelConfig;
  wallets: WalletRecord[];
  groups: string[];
  updatedAt: string;
};

type WalletSummary = {
  id: string;
  index: number;
  address: string;
  shortAddress: string;
  enabled: boolean;
  label: string;
  notes: string;
  groups: string[];
  nativeBalance?: string;
  reserveBalance?: string;
  tokenBalance?: string;
  borrowableAmount?: string;
  repayableAmount?: string;
  collateralBalance?: string;
  hasEnoughGas?: boolean;
  error?: string;
};

type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
type JobKind = "batch-buy" | "batch-sell" | "batch-borrow" | "batch-repay" | "random-market-make";
type JobAction = "buy" | "sell" | "borrow" | "repay";

type JobResult = {
  walletId: string;
  index: number;
  wallet: string;
  label: string;
  action: JobAction;
  amount: string;
  round?: number;
  status: "confirmed" | "failed" | "skipped" | "cancelled";
  hash?: string;
  error?: string;
  durationMs: number;
};

type JobSummary = {
  total: number;
  confirmed: number;
  failed: number;
  skipped: number;
  cancelled: number;
};

type Job = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  params: Record<string, unknown>;
  logs: string[];
  summary: JobSummary;
  results: JobResult[];
  error?: string;
  cancelRequested: boolean;
  cancelReason?: string;
  failureCount: number;
  consecutiveFailures: number;
};

type ExecutionWallet = {
  id: string;
  index: number;
  label: string;
  groups: string[];
  enabled: boolean;
  wallet: Wallet;
};

type RunContext = {
  provider: JsonRpcProvider;
  state: PanelState;
  tokenContract: Contract;
  reserveContract: Contract;
  marketContract: Contract;
  reserveSymbol: string;
  reserveDecimals: number;
  tokenSymbol: string;
  tokenDecimals: number;
};

type TaskSelection = {
  walletIds?: string[];
  groupNames?: string[];
  includeDisabled?: boolean;
};

type BatchTaskPayload = TaskSelection & {
  amount?: string;
  amountMin?: string;
  amountMax?: string;
  depositAmount?: string;
  debtAmount?: string;
  maxConcurrency?: number;
  intervalMinSec?: number;
  intervalMaxSec?: number;
  timeStart?: string;
  timeEnd?: string;
};

type RandomTaskPayload = TaskSelection & {
  rounds?: number;
  intervalMs?: number;
  walletsPerRound?: number;
  maxConcurrency?: number;
  buyProbabilityBps?: number;
  buyAmount?: string;
  reserveKeepAmount?: string;
  tokenKeepAmount?: string;
  maxSellAmount?: string;
  sellDivisor?: number;
};

type ExecutionWindow = {
  timeStart?: string;
  timeEnd?: string;
  intervalMinMs?: number;
  intervalMaxMs?: number;
};

type BatchExecutionOptions = ExecutionWindow & {
  amountMinWei?: bigint;
  amountMaxWei?: bigint;
  depositAmountWei?: bigint;
  repeatUntilWindowEnd?: boolean;
};

const rootDir = resolve(".");
const publicDir = resolve(rootDir, "panel", "public");
const runtimeRoot = process.env.RUNTIME_DATA_ROOT
  ? resolve(process.env.RUNTIME_DATA_ROOT)
  : rootDir;
const dataDir = process.env.PANEL_DATA_DIR
  ? resolve(process.env.PANEL_DATA_DIR)
  : resolve(runtimeRoot, "panel-data");
const reportsDir = process.env.REPORTS_DIR
  ? resolve(process.env.REPORTS_DIR)
  : resolve(runtimeRoot, "reports");
const walletsDir = process.env.WALLETS_DIR
  ? resolve(process.env.WALLETS_DIR)
  : resolve(runtimeRoot, "wallets");
const statePath = resolve(dataDir, "state.json");
const jobsStatePath = resolve(dataDir, "jobs.json");
const preferredPort = Number(process.env.PORT || process.env.PANEL_PORT || "3210");

const erc20Abi = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)"
];
const marketAbi = [
  "function buy(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function sell(address token,uint256 amountIn,uint256 minAmountOut,uint256 deadline)",
  "function borrow(address token,uint256 debtAmount)",
  "function repay(address token,uint256 amount)",
  "function depositAndBorrow(address token,uint256 depositAmount,uint256 debtAmount)",
  "function quoteBorrow(address token,address user,uint256 debtAmount) view returns (uint256 amountOut,(uint256 fee,uint256 reservePart,uint256 creatorPart,uint256 protocolPart,uint256 netAmount) fee,uint256 maxDebt,uint256 cashReserve)",
  "function marketState(address token) view returns ((uint256 totalSupply,uint256 reserve,uint256 currentPrice,uint256 athPrice,uint256 floorPrice))",
  "function positionOf(address token,address user) view returns ((uint256 collateralAmount,uint256 debtAmount))"
];

mkdirSync(dataDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
mkdirSync(walletsDir, { recursive: true });

let panelState = loadState();
const jobs = new Map<string, Job>();
let activeJobId: string | null = null;
loadPersistedJobs();

const server = createServer(async (req, res) => {
  try {
    const address = server.address();
    const currentPort = address && typeof address !== "string" ? address.port : preferredPort;
    const url = new URL(req.url || "/", `http://${req.headers.host || `127.0.0.1:${currentPort}`}`);

    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

startServer(server, preferredPort);

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, await statePayload());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readJsonBody(req);
    panelState.config = normalizeConfig(body?.config || {});
    persistState();
    sendJson(res, 200, { ok: true, config: panelState.config });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/wallets") {
    const refresh = url.searchParams.get("refresh") === "1";
    const wallets = refresh ? await fetchWalletSummaries(panelState) : basicWalletSummaries(panelState);
    sendJson(res, 200, {
      wallets,
      walletCount: panelState.wallets.length,
      groups: panelState.groups
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallets/import") {
    const body = await readJsonBody(req);
    const importedKeys = parsePrivateKeys(String(body?.privateKeys || ""));
    const imported = addWallets(importedKeys);
    sendJson(res, 200, {
      ok: true,
      imported,
      walletCount: panelState.wallets.length
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallets/import-generated") {
    const body = await readJsonBody(req);
    const requestedPath = String(body?.path || "wallets/generated-wallets.json");
    const imported = addWallets(importWalletsFromFile(requestedPath));
    sendJson(res, 200, {
      ok: true,
      imported,
      walletCount: panelState.wallets.length
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallets/clear") {
    panelState.wallets = [];
    panelState.groups = [];
    persistState();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallets/update") {
    const body = await readJsonBody(req);
    updateWallet(body);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wallets/bulk-label") {
    const body = await readJsonBody(req);
    applyBulkLabel(body);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJsonBody(req);
    const name = sanitizeGroupName(String(body?.name || ""));
    if (!name) throw new Error("Group name is required");
    if (!panelState.groups.includes(name)) {
      panelState.groups.push(name);
      panelState.groups.sort();
      persistState();
    }
    sendJson(res, 200, { ok: true, groups: panelState.groups });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups/delete") {
    const body = await readJsonBody(req);
    const name = sanitizeGroupName(String(body?.name || ""));
    panelState.groups = panelState.groups.filter((group) => group !== name);
    for (const wallet of panelState.wallets) {
      wallet.groups = wallet.groups.filter((group) => group !== name);
    }
    persistState();
    sendJson(res, 200, { ok: true, groups: panelState.groups });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/groups/assign") {
    const body = await readJsonBody(req);
    assignGroups(body);
    sendJson(res, 200, { ok: true, groups: panelState.groups });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/jobs") {
    sendJson(res, 200, { jobs: listJobs(), activeJobId });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
    const segments = url.pathname.split("/").filter(Boolean);
    const jobId = segments[2];
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }

    if (req.method === "GET" && segments.length === 3) {
      sendJson(res, 200, job);
      return;
    }
  }

  if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
    const segments = url.pathname.split("/").filter(Boolean);
    const jobId = segments[2];
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }

    job.cancelRequested = true;
    job.cancelReason = "Cancelled by operator";
    log(job, "Cancellation requested by operator");
    persistJobs();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/buy") {
    const body = (await readJsonBody(req)) as BatchTaskPayload;
    const amount = String(body?.amount || panelState.config.buyAmount);
    const maxConcurrency = positiveInt(body?.maxConcurrency, panelState.config.defaultMaxConcurrency);
    const selection = toSelection(body);
    const options: BatchExecutionOptions = {
      amountMinWei: parseOptionalBigInt(body?.amountMin || amount),
      amountMaxWei: parseOptionalBigInt(body?.amountMax || body?.amountMin || amount),
      intervalMinMs: positiveInt(body?.intervalMinSec, 0) * 1000,
      intervalMaxMs: positiveInt(body?.intervalMaxSec, 0) * 1000,
      timeStart: sanitizeTimeOfDay(body?.timeStart),
      timeEnd: sanitizeTimeOfDay(body?.timeEnd),
      repeatUntilWindowEnd: true
    };
    const targets = resolveExecutionWallets(panelState, selection);
    const job = createJob("batch-buy", {
      amount,
      amountMin: body?.amountMin || amount,
      amountMax: body?.amountMax || body?.amountMin || amount,
      maxConcurrency,
      intervalMinSec: body?.intervalMinSec || 0,
      intervalMaxSec: body?.intervalMaxSec || 0,
      timeStart: options.timeStart || "",
      timeEnd: options.timeEnd || "",
      selection
    });
    runJob(job, (currentJob) => runBatchTrade(currentJob, "buy", amount, maxConcurrency, targets, options)).catch(() => {});
    sendJson(res, 202, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/sell") {
    const body = (await readJsonBody(req)) as BatchTaskPayload;
    const amount = String(body?.amount || panelState.config.sellAmount);
    const maxConcurrency = positiveInt(body?.maxConcurrency, panelState.config.defaultMaxConcurrency);
    const selection = toSelection(body);
    const options: BatchExecutionOptions = {
      amountMinWei: parseOptionalBigInt(body?.amountMin || amount),
      amountMaxWei: parseOptionalBigInt(body?.amountMax || body?.amountMin || amount),
      intervalMinMs: positiveInt(body?.intervalMinSec, 0) * 1000,
      intervalMaxMs: positiveInt(body?.intervalMaxSec, 0) * 1000,
      timeStart: sanitizeTimeOfDay(body?.timeStart),
      timeEnd: sanitizeTimeOfDay(body?.timeEnd),
      repeatUntilWindowEnd: true
    };
    const targets = resolveExecutionWallets(panelState, selection);
    const job = createJob("batch-sell", {
      amount,
      amountMin: body?.amountMin || amount,
      amountMax: body?.amountMax || body?.amountMin || amount,
      maxConcurrency,
      intervalMinSec: body?.intervalMinSec || 0,
      intervalMaxSec: body?.intervalMaxSec || 0,
      timeStart: options.timeStart || "",
      timeEnd: options.timeEnd || "",
      selection
    });
    runJob(job, (currentJob) => runBatchTrade(currentJob, "sell", amount, maxConcurrency, targets, options)).catch(() => {});
    sendJson(res, 202, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/borrow") {
    const body = (await readJsonBody(req)) as BatchTaskPayload;
    const depositAmount = String(body?.depositAmount || body?.amount || panelState.config.buyAmount);
    const maxConcurrency = positiveInt(body?.maxConcurrency, panelState.config.defaultMaxConcurrency);
    const selection = toSelection(body);
    const options: BatchExecutionOptions = {
      depositAmountWei: parseOptionalBigInt(depositAmount),
      intervalMinMs: positiveInt(body?.intervalMinSec, 0) * 1000,
      intervalMaxMs: positiveInt(body?.intervalMaxSec, 0) * 1000,
      timeStart: sanitizeTimeOfDay(body?.timeStart),
      timeEnd: sanitizeTimeOfDay(body?.timeEnd),
      repeatUntilWindowEnd: true
    };
    const targets = resolveExecutionWallets(panelState, selection);
    const job = createJob("batch-borrow", {
      depositAmount,
      maxConcurrency,
      intervalMinSec: body?.intervalMinSec || 0,
      intervalMaxSec: body?.intervalMaxSec || 0,
      timeStart: options.timeStart || "",
      timeEnd: options.timeEnd || "",
      selection
    });
    runJob(job, (currentJob) =>
      runBatchTrade(currentJob, "borrow", "0", maxConcurrency, targets, {
        ...options,
        depositAmountWei: parseOptionalBigInt(depositAmount)
      })
    ).catch(() => {});
    sendJson(res, 202, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/repay") {
    const body = (await readJsonBody(req)) as BatchTaskPayload;
    const amount = String(body?.amount || panelState.config.sellAmount);
    const maxConcurrency = positiveInt(body?.maxConcurrency, panelState.config.defaultMaxConcurrency);
    const selection = toSelection(body);
    const options: BatchExecutionOptions = {
      amountMinWei: parseOptionalBigInt(body?.amountMin || amount),
      amountMaxWei: parseOptionalBigInt(body?.amountMax || body?.amountMin || amount),
      intervalMinMs: positiveInt(body?.intervalMinSec, 0) * 1000,
      intervalMaxMs: positiveInt(body?.intervalMaxSec, 0) * 1000,
      timeStart: sanitizeTimeOfDay(body?.timeStart),
      timeEnd: sanitizeTimeOfDay(body?.timeEnd),
      repeatUntilWindowEnd: true
    };
    const targets = resolveExecutionWallets(panelState, selection);
    const job = createJob("batch-repay", {
      amount,
      maxConcurrency,
      amountMin: body?.amountMin || amount,
      amountMax: body?.amountMax || body?.amountMin || amount,
      intervalMinSec: body?.intervalMinSec || 0,
      intervalMaxSec: body?.intervalMaxSec || 0,
      timeStart: options.timeStart || "",
      timeEnd: options.timeEnd || "",
      selection
    });
    runJob(job, (currentJob) => runBatchTrade(currentJob, "repay", amount, maxConcurrency, targets, options)).catch(() => {});
    sendJson(res, 202, { ok: true, jobId: job.id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/tasks/random") {
    const body = (await readJsonBody(req)) as RandomTaskPayload;
    const selection = toSelection(body);
    const targets = resolveExecutionWallets(panelState, selection);
    const params = {
      rounds: positiveInt(body?.rounds, panelState.config.randomRounds),
      intervalMs: positiveInt(body?.intervalMs, panelState.config.randomIntervalMs),
      walletsPerRound: positiveInt(body?.walletsPerRound, panelState.config.randomWalletsPerRound),
      maxConcurrency: positiveInt(body?.maxConcurrency, panelState.config.randomMaxConcurrency),
      buyProbabilityBps: positiveInt(body?.buyProbabilityBps, panelState.config.randomBuyProbabilityBps),
      buyAmount: String(body?.buyAmount || panelState.config.buyAmount),
      reserveKeepAmount: String(body?.reserveKeepAmount || panelState.config.randomReserveKeepAmount),
      tokenKeepAmount: String(body?.tokenKeepAmount || panelState.config.randomTokenKeepAmount),
      maxSellAmount: String(body?.maxSellAmount || panelState.config.randomMaxSellAmount),
      sellDivisor: positiveInt(body?.sellDivisor, panelState.config.randomSellDivisor),
      selection
    };
    const job = createJob("random-market-make", params);
    runJob(job, (currentJob) => runRandomMarketMaker(currentJob, params, targets)).catch(() => {});
    sendJson(res, 202, { ok: true, jobId: job.id });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function statePayload() {
  let assetMeta = {
    reserveSymbol: "RESERVE",
    reserveDecimals: 18,
    tokenSymbol: "TOKEN",
    tokenDecimals: 18
  };

  try {
    const context = await createContext(panelState);
    assetMeta = {
      reserveSymbol: context.reserveSymbol,
      reserveDecimals: context.reserveDecimals,
      tokenSymbol: context.tokenSymbol,
      tokenDecimals: context.tokenDecimals
    };
  } catch {
    // Keep the panel usable even when RPC or contract metadata is temporarily unavailable.
  }

  return {
    config: panelState.config,
    groups: panelState.groups,
    walletCount: panelState.wallets.length,
    activeJobId,
    jobs: listJobs(),
    assetMeta
  };
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const targetPath = pathname === "/" ? join(publicDir, "index.html") : resolve(publicDir, `.${pathname}`);
  if (!targetPath.startsWith(publicDir) || !existsSync(targetPath)) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const content = await readFile(targetPath);
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType(targetPath));
  res.end(content);
}

function contentType(filePath: string) {
  const ext = extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function loadState(): PanelState {
  if (!existsSync(statePath)) {
    const initialState = createInitialState();
    writeFileSync(statePath, JSON.stringify(initialState, null, 2));
    return initialState;
  }

  const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<PanelState> & {
    privateKeys?: string[];
  };
  const legacyKeys = Array.isArray(raw.privateKeys) ? raw.privateKeys : [];
  const envKeys = parsePrivateKeys(process.env.PRIVATE_KEYS || "");
  const rawWallets = Array.isArray(raw.wallets) ? raw.wallets : [];
  const wallets = normalizeWallets(rawWallets, [...legacyKeys, ...envKeys]);
  const groups = uniqueSorted([
    ...(Array.isArray(raw.groups) ? raw.groups.map((item) => sanitizeGroupName(String(item))) : []),
    ...wallets.flatMap((wallet) => wallet.groups)
  ]);

  return {
    config: normalizeConfig(raw.config || {}),
    wallets,
    groups,
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

function createInitialState(): PanelState {
  return {
    config: normalizeConfig({}),
    wallets: normalizeWallets([], parsePrivateKeys(process.env.PRIVATE_KEYS || "")),
    groups: [],
    updatedAt: new Date().toISOString()
  };
}

function normalizeWallets(rawWallets: unknown[], legacyKeys: string[]) {
  const byKey = new Map<string, WalletRecord>();
  for (const item of rawWallets) {
    const privateKey = String((item as { privateKey?: string })?.privateKey || "").trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) continue;
    if (byKey.has(privateKey)) continue;
    byKey.set(privateKey, {
      id: String((item as { id?: string })?.id || randomUUID()),
      privateKey,
      enabled: (item as { enabled?: boolean })?.enabled !== false,
      label: String((item as { label?: string })?.label || ""),
      groups: uniqueSorted(
        Array.isArray((item as { groups?: unknown[] })?.groups)
          ? (item as { groups?: unknown[] }).groups!.map((group) => sanitizeGroupName(String(group))).filter(Boolean)
          : []
      ),
      notes: String((item as { notes?: string })?.notes || ""),
      createdAt: String((item as { createdAt?: string })?.createdAt || new Date().toISOString())
    });
  }

  for (const privateKey of legacyKeys) {
    if (!byKey.has(privateKey)) {
      byKey.set(privateKey, {
        id: randomUUID(),
        privateKey,
        enabled: true,
        label: "",
        groups: [],
        notes: "",
        createdAt: new Date().toISOString()
      });
    }
  }

  return [...byKey.values()];
}

function persistState() {
  panelState.updatedAt = new Date().toISOString();
  panelState.groups = uniqueSorted([
    ...panelState.groups.map((group) => sanitizeGroupName(group)).filter(Boolean),
    ...panelState.wallets.flatMap((wallet) => wallet.groups)
  ]);
  writeFileSync(statePath, JSON.stringify(panelState, null, 2));
}

function loadPersistedJobs() {
  if (!existsSync(jobsStatePath)) return;
  try {
    const raw = JSON.parse(readFileSync(jobsStatePath, "utf8")) as {
      activeJobId?: string | null;
      jobs?: Job[];
    };

    const persistedJobs = Array.isArray(raw.jobs) ? raw.jobs : [];
    for (const job of persistedJobs) {
      if (job.status === "running" || job.status === "queued") {
        job.status = "failed";
        job.cancelRequested = true;
        job.cancelReason = "Service restarted while job was running";
        job.error = job.error || "Service restarted while job was running";
        job.endedAt = new Date().toISOString();
        job.logs = [...(job.logs || []), `[${new Date().toISOString()}] Service restarted; job marked as failed for safety`].slice(-500);
      }
      jobs.set(job.id, job);
    }

    activeJobId = null;
  } catch (error) {
    console.error("Failed to load persisted jobs:", error);
  }
}

function persistJobs() {
  const payload = {
    activeJobId,
    jobs: [...jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, 50)
  };
  writeFileSync(jobsStatePath, JSON.stringify(payload, null, 2));
}

function normalizeConfig(config: Partial<PanelConfig>): PanelConfig {
  const fallbackRisk = {
    maxWalletsPerTask: 100,
    maxAmountWeiPerOrder: "1000000000000000000000000",
    minNativeBalanceWei: process.env.MIN_ETH_WEI || "1000000000000000",
    minReserveBalanceWei: "0",
    minTokenBalanceWei: "0",
    minReserveLeftWei: "0",
    minTokenLeftWei: "0",
    stopOnTotalFailures: 8,
    stopOnConsecutiveFailures: 4
  };

  return {
    rpcUrl: String(config.rpcUrl || process.env.RPC_URL || ""),
    marketContractAddress: String(
      config.marketContractAddress ||
        process.env.LOOP_MARKET_CONTRACT ||
        process.env.BUY_CONTRACT_ADDRESS ||
        ""
    ),
    tokenAddress: String(
      config.tokenAddress || process.env.LOOP_TOKEN_ADDRESS || process.env.RANDOM_TRADE_TOKEN_ADDRESS || ""
    ),
    reserveTokenAddress: String(config.reserveTokenAddress || process.env.PAYMENT_TOKEN_ADDRESS || ""),
    deadlineSeconds: positiveInt(config.deadlineSeconds, Number(process.env.DEADLINE_SECONDS || 600)),
    receiptTimeoutMs: positiveInt(config.receiptTimeoutMs, Number(process.env.RECEIPT_TIMEOUT_MS || 180000)),
    defaultMaxConcurrency: positiveInt(
      config.defaultMaxConcurrency,
      Number(process.env.MAX_CONCURRENCY || 10)
    ),
    buyAmount: String(config.buyAmount || process.env.RANDOM_TRADE_BUY_AMOUNT || "1000000000000000000"),
    sellAmount: String(config.sellAmount || process.env.RANDOM_TRADE_MAX_SELL_AMOUNT || "1000000000000000000"),
    randomRounds: positiveInt(config.randomRounds, Number(process.env.RANDOM_TRADE_ROUNDS || 12)),
    randomIntervalMs: positiveInt(
      config.randomIntervalMs,
      Number(process.env.RANDOM_TRADE_INTERVAL_MS || 60000)
    ),
    randomWalletsPerRound: positiveInt(
      config.randomWalletsPerRound,
      Number(process.env.RANDOM_TRADE_WALLETS_PER_ROUND || 20)
    ),
    randomMaxConcurrency: positiveInt(
      config.randomMaxConcurrency,
      Number(process.env.RANDOM_TRADE_MAX_CONCURRENCY || process.env.MAX_CONCURRENCY || 5)
    ),
    randomBuyProbabilityBps: positiveInt(
      config.randomBuyProbabilityBps,
      Number(process.env.RANDOM_TRADE_BUY_PROBABILITY_BPS || 5000)
    ),
    randomReserveKeepAmount: String(
      config.randomReserveKeepAmount ||
        process.env.RANDOM_TRADE_RESERVE_KEEP_AMOUNT ||
        "10000000000000000000000"
    ),
    randomTokenKeepAmount: String(
      config.randomTokenKeepAmount || process.env.RANDOM_TRADE_TOKEN_KEEP_AMOUNT || "1000000000000000000"
    ),
    randomMaxSellAmount: String(
      config.randomMaxSellAmount || process.env.RANDOM_TRADE_MAX_SELL_AMOUNT || "5000000000000000000"
    ),
    randomSellDivisor: positiveInt(
      config.randomSellDivisor,
      Number(process.env.RANDOM_TRADE_SELL_DIVISOR || 5)
    ),
    riskControls: {
      maxWalletsPerTask: positiveInt(
        config.riskControls?.maxWalletsPerTask,
        fallbackRisk.maxWalletsPerTask
      ),
      maxAmountWeiPerOrder: String(
        config.riskControls?.maxAmountWeiPerOrder || fallbackRisk.maxAmountWeiPerOrder
      ),
      minNativeBalanceWei: String(
        config.riskControls?.minNativeBalanceWei || fallbackRisk.minNativeBalanceWei
      ),
      minReserveBalanceWei: String(
        config.riskControls?.minReserveBalanceWei || fallbackRisk.minReserveBalanceWei
      ),
      minTokenBalanceWei: String(
        config.riskControls?.minTokenBalanceWei || fallbackRisk.minTokenBalanceWei
      ),
      minReserveLeftWei: String(
        config.riskControls?.minReserveLeftWei || fallbackRisk.minReserveLeftWei
      ),
      minTokenLeftWei: String(
        config.riskControls?.minTokenLeftWei || fallbackRisk.minTokenLeftWei
      ),
      stopOnTotalFailures: positiveInt(
        config.riskControls?.stopOnTotalFailures,
        fallbackRisk.stopOnTotalFailures
      ),
      stopOnConsecutiveFailures: positiveInt(
        config.riskControls?.stopOnConsecutiveFailures,
        fallbackRisk.stopOnConsecutiveFailures
      )
    }
  };
}

function parsePrivateKeys(raw: string) {
  return uniqueSorted(
    raw
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter((item) => /^0x[a-fA-F0-9]{64}$/.test(item))
  );
}

function importWalletsFromFile(filePath: string) {
  const absolute = resolve(rootDir, filePath);
  if (!absolute.startsWith(rootDir)) {
    throw new Error("Wallet file path is outside the project");
  }
  if (!existsSync(absolute)) {
    throw new Error(`Wallet file not found: ${filePath}`);
  }

  if (absolute.endsWith(".json")) {
    const json = JSON.parse(readFileSync(absolute, "utf8"));
    if (!Array.isArray(json)) {
      throw new Error("Wallet JSON must be an array");
    }
    return json
      .map((item) => String(item?.privateKey || ""))
      .filter((item) => /^0x[a-fA-F0-9]{64}$/.test(item));
  }

  return parsePrivateKeys(readFileSync(absolute, "utf8").replace("PRIVATE_KEYS=", ""));
}

function addWallets(privateKeys: string[]) {
  let imported = 0;
  const existing = new Set(panelState.wallets.map((wallet) => wallet.privateKey));
  for (const privateKey of privateKeys) {
    if (existing.has(privateKey)) continue;
    panelState.wallets.push({
      id: randomUUID(),
      privateKey,
      enabled: true,
      label: "",
      groups: [],
      notes: "",
      createdAt: new Date().toISOString()
    });
    imported += 1;
  }
  persistState();
  return imported;
}

function updateWallet(input: unknown) {
  const payload = input as Partial<WalletRecord> & { id?: string };
  const wallet = panelState.wallets.find((item) => item.id === payload.id);
  if (!wallet) throw new Error("Wallet not found");
  if (typeof payload.enabled === "boolean") wallet.enabled = payload.enabled;
  if (payload.label !== undefined) wallet.label = String(payload.label || "").slice(0, 64);
  if (payload.notes !== undefined) wallet.notes = String(payload.notes || "").slice(0, 240);
  persistState();
}

function applyBulkLabel(input: unknown) {
  const payload = input as {
    walletIds?: string[];
    labelPrefix?: string;
    replaceExisting?: boolean;
  };
  const walletIds = Array.isArray(payload.walletIds) ? payload.walletIds.map(String) : [];
  const labelPrefix = String(payload.labelPrefix || "").trim().slice(0, 48);
  const replaceExisting = payload.replaceExisting !== false;

  if (walletIds.length === 0) throw new Error("Select at least one wallet");
  if (!labelPrefix) throw new Error("Label prefix is required");

  const selectedWallets = panelState.wallets.filter((wallet) => walletIds.includes(wallet.id));
  if (selectedWallets.length === 0) throw new Error("No matching wallets found");

  selectedWallets.forEach((wallet, index) => {
    if (!replaceExisting && wallet.label.trim()) return;
    wallet.label = `${labelPrefix}-${String(index + 1).padStart(2, "0")}`.slice(0, 64);
  });

  persistState();
}

function assignGroups(input: unknown) {
  const payload = input as {
    walletIds?: string[];
    groupNames?: string[];
    mode?: "add" | "replace" | "remove";
  };
  const walletIds = Array.isArray(payload.walletIds) ? payload.walletIds.map(String) : [];
  const groupNames = uniqueSorted(
    (Array.isArray(payload.groupNames) ? payload.groupNames : [])
      .map((group) => sanitizeGroupName(String(group)))
      .filter(Boolean)
  );
  const mode = payload.mode || "add";

  if (walletIds.length === 0) throw new Error("Select at least one wallet");
  if (groupNames.length === 0 && mode !== "replace") throw new Error("Select at least one group");

  for (const group of groupNames) {
    if (!panelState.groups.includes(group)) panelState.groups.push(group);
  }

  for (const wallet of panelState.wallets) {
    if (!walletIds.includes(wallet.id)) continue;
    if (mode === "replace") {
      wallet.groups = groupNames;
    } else if (mode === "remove") {
      wallet.groups = wallet.groups.filter((group) => !groupNames.includes(group));
    } else {
      wallet.groups = uniqueSorted([...wallet.groups, ...groupNames]);
    }
  }

  persistState();
}

function basicWalletSummaries(state: PanelState): WalletSummary[] {
  return state.wallets.map((record, index) => {
    const wallet = new Wallet(record.privateKey);
    return {
      id: record.id,
      index,
      address: wallet.address,
      shortAddress: shortAddress(wallet.address),
      enabled: record.enabled,
      label: record.label,
      notes: record.notes,
      groups: record.groups
    };
  });
}

async function fetchWalletSummaries(state: PanelState) {
  const context = await createContext(state);
  const gasThreshold = BigInt(state.config.riskControls.minNativeBalanceWei);
  const entries = state.wallets.map((record, index) => ({
    record,
    index,
    wallet: new Wallet(record.privateKey)
  }));

  return runWithConcurrency(
    entries.map(({ record, index, wallet }) => async () => {
      try {
        const [nativeBalance, reserveBalance, tokenBalance, position, marketState] = await Promise.all([
          context.provider.getBalance(wallet.address),
          context.reserveContract.balanceOf(wallet.address),
          context.tokenContract.balanceOf(wallet.address),
          context.marketContract.positionOf(context.state.config.tokenAddress, wallet.address),
          context.marketContract.marketState(context.state.config.tokenAddress)
        ]);
        const collateralAmount = BigInt(position.collateralAmount?.toString?.() ?? position[0]?.toString?.() ?? "0");
        const debtAmount = BigInt(position.debtAmount?.toString?.() ?? position[1]?.toString?.() ?? "0");
        const floorPrice = BigInt(marketState.floorPrice?.toString?.() ?? marketState[4]?.toString?.() ?? "0");
        const theoreticalLimit =
          (collateralAmount * floorPrice) / 10n ** BigInt(Math.max(0, context.tokenDecimals));
        let borrowableAmount = 0n;
        if (theoreticalLimit > 0n) {
          try {
            const quote = await context.marketContract.quoteBorrow(
              context.state.config.tokenAddress,
              wallet.address,
              theoreticalLimit
            );
            const quotedMaxDebt = BigInt(quote.maxDebt?.toString?.() ?? quote[2]?.toString?.() ?? "0");
            borrowableAmount = quotedMaxDebt < theoreticalLimit ? quotedMaxDebt : theoreticalLimit;
          } catch {
            borrowableAmount = 0n;
          }
        }
        return {
          id: record.id,
          index,
          address: wallet.address,
          shortAddress: shortAddress(wallet.address),
          enabled: record.enabled,
          label: record.label,
          notes: record.notes,
          groups: record.groups,
          nativeBalance: formatUnits(nativeBalance, 18),
          reserveBalance: formatUnits(reserveBalance, context.reserveDecimals),
          tokenBalance: formatUnits(tokenBalance, context.tokenDecimals),
          collateralBalance: formatUnits(collateralAmount, context.tokenDecimals),
          borrowableAmount: formatUnits(borrowableAmount, context.reserveDecimals),
          repayableAmount: formatUnits(debtAmount, context.reserveDecimals),
          hasEnoughGas: nativeBalance >= gasThreshold
        } satisfies WalletSummary;
      } catch (error) {
        return {
          id: record.id,
          index,
          address: wallet.address,
          shortAddress: shortAddress(wallet.address),
          enabled: record.enabled,
          label: record.label,
          notes: record.notes,
          groups: record.groups,
          error: error instanceof Error ? error.message : String(error)
        } satisfies WalletSummary;
      }
    }),
    Math.min(10, Math.max(1, entries.length))
  );
}

function toSelection(payload: TaskSelection): TaskSelection {
  return {
    walletIds: Array.isArray(payload.walletIds) ? payload.walletIds.map(String) : [],
    groupNames: Array.isArray(payload.groupNames)
      ? payload.groupNames.map((group) => sanitizeGroupName(String(group))).filter(Boolean)
      : [],
    includeDisabled: Boolean(payload.includeDisabled)
  };
}

function resolveExecutionWallets(state: PanelState, selection: TaskSelection) {
  let walletPool = state.wallets.filter((wallet) => selection.includeDisabled || wallet.enabled);

  if (selection.groupNames && selection.groupNames.length > 0) {
    walletPool = walletPool.filter((wallet) =>
      wallet.groups.some((group) => selection.groupNames!.includes(group))
    );
  }

  if (selection.walletIds && selection.walletIds.length > 0) {
    const walletIdSet = new Set(selection.walletIds);
    walletPool = walletPool.filter((wallet) => walletIdSet.has(wallet.id));
  }

  if (walletPool.length === 0) {
    throw new Error("No wallets matched the current selection");
  }

  if (walletPool.length > state.config.riskControls.maxWalletsPerTask) {
    throw new Error(
      `Wallet selection exceeds maxWalletsPerTask ${state.config.riskControls.maxWalletsPerTask}`
    );
  }

  return walletPool.map((record) => ({
    id: record.id,
    index: state.wallets.findIndex((item) => item.id === record.id),
    label: record.label,
    groups: record.groups,
    enabled: record.enabled,
    wallet: new Wallet(record.privateKey)
  }));
}

function createJob(kind: JobKind, params: Record<string, unknown>) {
  if (activeJobId) {
    throw new Error("Another job is already running");
  }

  const job: Job = {
    id: randomUUID(),
    kind,
    status: "queued",
    createdAt: new Date().toISOString(),
    params,
    logs: [],
    summary: {
      total: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0
    },
    results: [],
    cancelRequested: false,
    failureCount: 0,
    consecutiveFailures: 0
  };

  jobs.set(job.id, job);
  activeJobId = job.id;
  persistJobs();
  return job;
}

async function runJob(job: Job, runner: (job: Job) => Promise<void>) {
  job.status = "running";
  job.startedAt = new Date().toISOString();
  log(job, `Job ${job.kind} started`);
  persistJobs();

  try {
    await runner(job);
    if (job.cancelRequested) {
      job.status = "cancelled";
      log(job, job.cancelReason || "Job cancelled");
    } else {
      job.status = "completed";
      log(job, `Job completed with ${job.summary.confirmed} confirmed`);
    }
  } catch (error) {
    if (job.cancelRequested) {
      job.status = "cancelled";
      log(job, job.cancelReason || "Job cancelled");
    } else {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
      log(job, `Job failed: ${job.error}`);
    }
  } finally {
    job.endedAt = new Date().toISOString();
    activeJobId = null;
    saveJobReport(job);
    persistJobs();
  }
}

function listJobs() {
  return [...jobs.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20)
    .map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      summary: job.summary,
      error: job.error,
      cancelRequested: job.cancelRequested
    }));
}

async function runBatchTrade(
  job: Job,
  action: JobAction,
  amount: string,
  maxConcurrency: number,
  targets: ExecutionWallet[],
  options?: BatchExecutionOptions
) {
  validateState(panelState);
  const context = await createContext(panelState);
  const amountWei = BigInt(amount);
  const depositAmountWei = options?.depositAmountWei;
  const perWalletTimeoutMs = Math.max(30000, context.state.config.receiptTimeoutMs + 60000);
  if (action !== "borrow") validateAmountAgainstRisk(panelState.config, amountWei);
  if (depositAmountWei !== undefined) validateAmountAgainstRisk(panelState.config, depositAmountWei);
  job.summary.total = 0;
  log(job, `${action.toUpperCase()} started for ${targets.length} wallets`);

  const connectedTargets = targets.map((entry) => ({
    ...entry,
    wallet: entry.wallet.connect(context.provider)
  }));

  const results: JobResult[] = [];
  let round = 1;

  while (true) {
    assertJobNotCancelled(job);
    await waitForExecutionWindow(job, options);

    if (options?.timeStart && options?.timeEnd && !isWithinTimeWindow(new Date(), options.timeStart, options.timeEnd)) {
      break;
    }

    log(job, `Starting batch round ${round}`);

    if (maxConcurrency <= 1) {
      for (let i = 0; i < connectedTargets.length; i++) {
        const entry = connectedTargets[i];
        assertJobNotCancelled(job);

        if (options?.timeStart && options?.timeEnd && !isWithinTimeWindow(new Date(), options.timeStart, options.timeEnd)) {
          log(job, `Execution window ended during round ${round}`);
          return results;
        }

        const effectiveAmountWei =
          action === "borrow"
            ? amountWei
            : pickEffectiveAmountWei(
                panelState.config,
                options?.amountMinWei ?? amountWei,
                options?.amountMaxWei ?? options?.amountMinWei ?? amountWei
              );
        if (action !== "borrow") {
          log(job, `round ${round} #${entry.index + 1} selected amount ${effectiveAmountWei.toString()}`);
        }

        const result = await waitWithTimeout(
          (async () => {
            if (action === "buy") return buyForWallet(job, context, entry, effectiveAmountWei, round);
            if (action === "sell") return sellForWallet(job, context, entry, effectiveAmountWei, round);
            if (action === "borrow") {
              return borrowForWallet(job, context, entry, amountWei, depositAmountWei ?? amountWei, round);
            }
            return repayForWallet(job, context, entry, effectiveAmountWei, round);
          })(),
          perWalletTimeoutMs
        );

        results.push(result);
        job.summary.total += 1;
        pushResult(job, result);
        evaluateRiskAfterResult(job);
        log(job, `round ${round} #${result.index + 1} ${result.action} ${result.status}${result.error ? `: ${result.error}` : ""}`);

        if (i < connectedTargets.length - 1) {
          await waitRandomInterval(job, options);
        }
      }
    } else {
      job.summary.total += connectedTargets.length;
      const roundResults = await runWithConcurrency(
        connectedTargets.map((entry) => async () => {
          assertJobNotCancelled(job);

          const effectiveAmountWei =
            action === "borrow"
              ? amountWei
              : pickEffectiveAmountWei(
                  panelState.config,
                  options?.amountMinWei ?? amountWei,
                  options?.amountMaxWei ?? options?.amountMinWei ?? amountWei
                );
          if (action !== "borrow") {
            log(job, `round ${round} #${entry.index + 1} selected amount ${effectiveAmountWei.toString()}`);
          }

          return waitWithTimeout(
            (async () => {
              if (action === "buy") return buyForWallet(job, context, entry, effectiveAmountWei, round);
              if (action === "sell") return sellForWallet(job, context, entry, effectiveAmountWei, round);
              if (action === "borrow") {
                return borrowForWallet(job, context, entry, amountWei, depositAmountWei ?? amountWei, round);
              }
              return repayForWallet(job, context, entry, effectiveAmountWei, round);
            })(),
            perWalletTimeoutMs
          );
        }),
        maxConcurrency,
        () =>
          job.cancelRequested ||
          Boolean(options?.timeStart && options?.timeEnd && !isWithinTimeWindow(new Date(), options.timeStart, options.timeEnd)),
        (result) => {
          results.push(result);
          pushResult(job, result);
          evaluateRiskAfterResult(job);
          log(job, `round ${round} #${result.index + 1} ${result.action} ${result.status}${result.error ? `: ${result.error}` : ""}`);
        }
      );
      void roundResults;
    }

    if (!(options?.repeatUntilWindowEnd && options?.timeStart && options?.timeEnd && isWithinTimeWindow(new Date(), options.timeStart, options.timeEnd))) {
      break;
    }

    round += 1;
  }

  return results;
}

async function runRandomMarketMaker(
  job: Job,
  params: Required<Omit<RandomTaskPayload, keyof TaskSelection>> & { selection: TaskSelection },
  targets: ExecutionWallet[]
) {
  validateState(panelState);
  const context = await createContext(panelState);
  const buyAmount = BigInt(params.buyAmount);
  const reserveKeepAmount = BigInt(params.reserveKeepAmount);
  const tokenKeepAmount = BigInt(params.tokenKeepAmount);
  const maxSellAmount = BigInt(params.maxSellAmount);
  const perWalletTimeoutMs = Math.max(30000, context.state.config.receiptTimeoutMs + 60000);
  validateAmountAgainstRisk(panelState.config, buyAmount);

  if (targets.length === 0) throw new Error("No wallets matched the random task selection");
  job.summary.total = params.rounds * Math.min(params.walletsPerRound, targets.length);
  log(job, `Random market maker started for ${params.rounds} rounds`);

  const connectedTargets = targets.map((entry) => ({
    ...entry,
    wallet: entry.wallet.connect(context.provider)
  }));

  for (let round = 1; round <= params.rounds; round++) {
    assertJobNotCancelled(job);
    if (round > 1) {
      log(job, `Waiting ${params.intervalMs}ms before round ${round}`);
      await sleepWithCancel(params.intervalMs, job);
    }

    const selected = sampleWallets(connectedTargets, params.walletsPerRound);
    log(job, `Round ${round}: selected ${selected.length} wallets`);

    const roundResults = await runWithConcurrency(
      selected.map((entry) => async () => {
        assertJobNotCancelled(job);
        return waitWithTimeout(
          (async () => {
            const wantBuy = Math.floor(Math.random() * 10000) < params.buyProbabilityBps;
            if (wantBuy) {
              const reserveBalance = await context.reserveContract.balanceOf(entry.wallet.address);
              if (reserveBalance < buyAmount + reserveKeepAmount) {
                return sellRemainder(
                  job,
                  context,
                  entry,
                  round,
                  tokenKeepAmount,
                  maxSellAmount,
                  params.sellDivisor
                );
              }
              return buyForWallet(job, context, entry, buyAmount, round);
            }

            return sellRemainder(
              job,
              context,
              entry,
              round,
              tokenKeepAmount,
              maxSellAmount,
              params.sellDivisor
            );
          })(),
          perWalletTimeoutMs
        );
      }),
      params.maxConcurrency,
      () => job.cancelRequested,
      (result) => {
        pushResult(job, result);
        evaluateRiskAfterResult(job);
        log(job, `round ${result.round || round} #${result.index + 1} ${result.action} ${result.status}${result.error ? `: ${result.error}` : ""}`);
      }
    );
    void roundResults;
  }
}

async function buyForWallet(
  job: Job,
  context: RunContext,
  entry: ExecutionWallet,
  amountWei: bigint,
  round?: number
): Promise<JobResult> {
  const startedAt = Date.now();

  try {
    assertJobNotCancelled(job);
    const risk = context.state.config.riskControls;
    const [nativeBalance, reserveBalance] = await Promise.all([
      context.provider.getBalance(entry.wallet.address),
      context.reserveContract.balanceOf(entry.wallet.address)
    ]);

    if (nativeBalance < BigInt(risk.minNativeBalanceWei)) {
      return skippedResult(entry, "buy", amountWei, startedAt, "Native balance below risk threshold", round);
    }
    if (reserveBalance < BigInt(risk.minReserveBalanceWei)) {
      return skippedResult(entry, "buy", amountWei, startedAt, "Reserve balance below risk threshold", round);
    }
    if (reserveBalance < amountWei + BigInt(risk.minReserveLeftWei)) {
      return skippedResult(entry, "buy", amountWei, startedAt, "Reserve left-after-trade threshold not met", round);
    }

    await ensureApproval(entry.wallet, context.reserveContract, context.state.config.marketContractAddress, amountWei);
    assertJobNotCancelled(job);
    const connected = context.marketContract.connect(entry.wallet) as Contract;
    const deadline = Math.floor(Date.now() / 1000) + context.state.config.deadlineSeconds;
    const tx = await connected.buy(context.state.config.tokenAddress, amountWei, 0, deadline);
    log(job, `#${entry.index + 1} buy submitted ${tx.hash}`);
    const receipt = await waitWithTimeout(tx.wait(), context.state.config.receiptTimeoutMs);
    if (receipt?.status !== 1) throw new Error(`Buy reverted: ${tx.hash}`);
    return {
      walletId: entry.id,
      index: entry.index,
      wallet: entry.wallet.address,
      label: entry.label,
      action: "buy",
      amount: amountWei.toString(),
      round,
      status: "confirmed",
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return failedResult(entry, "buy", amountWei, startedAt, error, round, job.cancelRequested);
  }
}

async function sellForWallet(
  job: Job,
  context: RunContext,
  entry: ExecutionWallet,
  amountWei: bigint,
  round?: number
): Promise<JobResult> {
  const startedAt = Date.now();

  try {
    assertJobNotCancelled(job);
    const risk = context.state.config.riskControls;
    const [nativeBalance, tokenBalance] = await Promise.all([
      context.provider.getBalance(entry.wallet.address),
      context.tokenContract.balanceOf(entry.wallet.address)
    ]);

    if (nativeBalance < BigInt(risk.minNativeBalanceWei)) {
      return skippedResult(entry, "sell", amountWei, startedAt, "Native balance below risk threshold", round);
    }
    if (tokenBalance < BigInt(risk.minTokenBalanceWei)) {
      return skippedResult(entry, "sell", amountWei, startedAt, "Token balance below risk threshold", round);
    }
    if (tokenBalance < amountWei + BigInt(risk.minTokenLeftWei)) {
      return skippedResult(entry, "sell", amountWei, startedAt, "Token left-after-trade threshold not met", round);
    }

    await ensureApproval(entry.wallet, context.tokenContract, context.state.config.marketContractAddress, amountWei);
    assertJobNotCancelled(job);
    const connected = context.marketContract.connect(entry.wallet) as Contract;
    const deadline = Math.floor(Date.now() / 1000) + context.state.config.deadlineSeconds;
    const tx = await connected.sell(context.state.config.tokenAddress, amountWei, 0, deadline);
    log(job, `#${entry.index + 1} sell submitted ${tx.hash}`);
    const receipt = await waitWithTimeout(tx.wait(), context.state.config.receiptTimeoutMs);
    if (receipt?.status !== 1) throw new Error(`Sell reverted: ${tx.hash}`);
    return {
      walletId: entry.id,
      index: entry.index,
      wallet: entry.wallet.address,
      label: entry.label,
      action: "sell",
      amount: amountWei.toString(),
      round,
      status: "confirmed",
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return failedResult(entry, "sell", amountWei, startedAt, error, round, job.cancelRequested);
  }
}

async function borrowForWallet(
  job: Job,
  context: RunContext,
  entry: ExecutionWallet,
  amountWei: bigint,
  depositAmountWei: bigint,
  round?: number
): Promise<JobResult> {
  const startedAt = Date.now();

  try {
    assertJobNotCancelled(job);
    const risk = context.state.config.riskControls;
    const [nativeBalance, tokenBalance] = await Promise.all([
      context.provider.getBalance(entry.wallet.address),
      context.tokenContract.balanceOf(entry.wallet.address)
    ]);

    if (nativeBalance < BigInt(risk.minNativeBalanceWei)) {
      return skippedResult(entry, "borrow", amountWei, startedAt, "Native balance below risk threshold", round);
    }
    if (tokenBalance < BigInt(risk.minTokenBalanceWei)) {
      return skippedResult(entry, "borrow", amountWei, startedAt, "Token balance below risk threshold", round);
    }
    if (tokenBalance < depositAmountWei + BigInt(risk.minTokenLeftWei)) {
      return skippedResult(entry, "borrow", amountWei, startedAt, "Token balance is insufficient for collateral deposit", round);
    }

    await ensureApproval(entry.wallet, context.tokenContract, context.state.config.marketContractAddress, depositAmountWei);
    assertJobNotCancelled(job);

    const connected = context.marketContract.connect(entry.wallet) as Contract;
    const marketState = await connected.marketState(context.state.config.tokenAddress);
    const floorPrice = BigInt(marketState.floorPrice?.toString?.() ?? marketState[4]?.toString?.() ?? "0");
    const theoreticalLimit =
      (depositAmountWei * floorPrice) / 10n ** BigInt(Math.max(0, context.tokenDecimals));
    const quote = await connected.quoteBorrow(context.state.config.tokenAddress, entry.wallet.address, theoreticalLimit);
    const quotedMaxDebt = BigInt(quote.maxDebt?.toString?.() ?? quote[2]?.toString?.() ?? "0");
    let maxDebt = quotedMaxDebt < theoreticalLimit ? quotedMaxDebt : theoreticalLimit;

    // For new collateral positions, quoteBorrow may return 0 until the deposit is included.
    // In that case, probe depositAndBorrow.staticCall directly to discover the true max debt.
    if (maxDebt <= 0n || !(await canDepositAndBorrow(connected, context.state.config.tokenAddress, depositAmountWei, maxDebt))) {
      maxDebt = await findMaxBorrowForDeposit(
        connected,
        context.state.config.tokenAddress,
        depositAmountWei,
        theoreticalLimit
      );
    }
    if (maxDebt <= 0n) {
      return skippedResult(entry, "borrow", amountWei, startedAt, "No borrowable amount for this collateral", round);
    }

    await connected.depositAndBorrow.staticCall(context.state.config.tokenAddress, depositAmountWei, maxDebt);
    const tx = await connected.depositAndBorrow(context.state.config.tokenAddress, depositAmountWei, maxDebt);
    log(job, `#${entry.index + 1} depositAndBorrow submitted ${tx.hash}`);
    const receipt = await waitWithTimeout(tx.wait(), context.state.config.receiptTimeoutMs);
    if (receipt?.status !== 1) throw new Error(`depositAndBorrow reverted: ${tx.hash}`);
    return {
      walletId: entry.id,
      index: entry.index,
      wallet: entry.wallet.address,
      label: entry.label,
      action: "borrow",
      amount: maxDebt.toString(),
      round,
      status: "confirmed",
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return failedResult(entry, "borrow", amountWei, startedAt, error, round, job.cancelRequested);
  }
}

async function repayForWallet(
  job: Job,
  context: RunContext,
  entry: ExecutionWallet,
  amountWei: bigint,
  round?: number
): Promise<JobResult> {
  const startedAt = Date.now();

  try {
    assertJobNotCancelled(job);
    const risk = context.state.config.riskControls;
    const [nativeBalance, reserveBalance, position] = await Promise.all([
      context.provider.getBalance(entry.wallet.address),
      context.reserveContract.balanceOf(entry.wallet.address),
      context.marketContract.positionOf(context.state.config.tokenAddress, entry.wallet.address)
    ]);
    const debtAmount = BigInt(position.debtAmount?.toString?.() ?? position[1]?.toString?.() ?? "0");

    if (nativeBalance < BigInt(risk.minNativeBalanceWei)) {
      return skippedResult(entry, "repay", amountWei, startedAt, "Native balance below risk threshold", round);
    }
    if (reserveBalance < BigInt(risk.minReserveBalanceWei)) {
      return skippedResult(entry, "repay", amountWei, startedAt, "Reserve balance below risk threshold", round);
    }
    if (debtAmount <= 0n) {
      return skippedResult(entry, "repay", amountWei, startedAt, "No repayable debt", round);
    }

    const repayAmount = [amountWei, debtAmount, reserveBalance].reduce((min, current) => (current < min ? current : min));
    if (repayAmount <= 0n) {
      return skippedResult(entry, "repay", amountWei, startedAt, "No repayable amount after balance/debt clamp", round);
    }

    await ensureApproval(entry.wallet, context.reserveContract, context.state.config.marketContractAddress, repayAmount);
    assertJobNotCancelled(job);
    const connected = context.marketContract.connect(entry.wallet) as Contract;
    const tx = await connected.repay(context.state.config.tokenAddress, repayAmount);
    log(job, `#${entry.index + 1} repay submitted ${tx.hash}`);
    const receipt = await waitWithTimeout(tx.wait(), context.state.config.receiptTimeoutMs);
    if (receipt?.status !== 1) throw new Error(`Repay reverted: ${tx.hash}`);
    return {
      walletId: entry.id,
      index: entry.index,
      wallet: entry.wallet.address,
      label: entry.label,
      action: "repay",
      amount: repayAmount.toString(),
      round,
      status: "confirmed",
      hash: tx.hash,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return failedResult(entry, "repay", amountWei, startedAt, error, round, job.cancelRequested);
  }
}

async function sellRemainder(
  job: Job,
  context: RunContext,
  entry: ExecutionWallet,
  round: number,
  tokenKeepAmount: bigint,
  maxSellAmount: bigint,
  sellDivisor: number
) {
  const tokenBalance = await context.tokenContract.balanceOf(entry.wallet.address);
  if (tokenBalance <= tokenKeepAmount) {
    return skippedResult(entry, "sell", 0n, Date.now(), "No sellable token balance", round);
  }
  const sellable = tokenBalance - tokenKeepAmount;
  let amountWei = sellable / BigInt(Math.max(1, sellDivisor));
  if (amountWei <= 0n) amountWei = sellable;
  if (amountWei > maxSellAmount) amountWei = maxSellAmount;
  validateAmountAgainstRisk(context.state.config, amountWei);
  return sellForWallet(job, context, entry, amountWei, round);
}

async function ensureApproval(wallet: Wallet, contract: Contract, spender: string, amountWei: bigint) {
  const allowance = await contract.allowance(wallet.address, spender);
  if (allowance >= amountWei) return;
  const tx = await contract.connect(wallet).approve(spender, amountWei);
  const receipt = await tx.wait();
  if (receipt?.status !== 1) throw new Error(`Approve failed: ${tx.hash}`);
}

async function createContext(state: PanelState): Promise<RunContext> {
  validateState(state);
  const provider = new JsonRpcProvider(state.config.rpcUrl);
  const tokenContract = new Contract(state.config.tokenAddress, erc20Abi, provider);
  const reserveContract = new Contract(state.config.reserveTokenAddress, erc20Abi, provider);
  const marketContract = new Contract(state.config.marketContractAddress, marketAbi, provider);
  const [reserveSymbol, reserveDecimals, tokenSymbol, tokenDecimals] = await Promise.all([
    reserveContract.symbol(),
    reserveContract.decimals(),
    tokenContract.symbol(),
    tokenContract.decimals()
  ]);
  return {
    provider,
    state,
    tokenContract,
    reserveContract,
    marketContract,
    reserveSymbol,
    reserveDecimals: Number(reserveDecimals),
    tokenSymbol,
    tokenDecimals: Number(tokenDecimals)
  };
}

function validateState(state: PanelState) {
  if (!state.config.rpcUrl) throw new Error("RPC URL is required");
  for (const [label, value] of [
    ["marketContractAddress", state.config.marketContractAddress],
    ["tokenAddress", state.config.tokenAddress],
    ["reserveTokenAddress", state.config.reserveTokenAddress]
  ] as const) {
    if (!isAddress(value)) throw new Error(`${label} is invalid`);
  }
}

function validateAmountAgainstRisk(config: PanelConfig, amountWei: bigint) {
  if (amountWei <= 0n) throw new Error("Amount must be greater than zero");
  if (amountWei > BigInt(config.riskControls.maxAmountWeiPerOrder)) {
    throw new Error("Amount exceeds maxAmountWeiPerOrder");
  }
}

function pushResult(job: Job, result: JobResult) {
  job.results.push(result);
  if (result.status === "confirmed") {
    job.summary.confirmed += 1;
    job.consecutiveFailures = 0;
  } else if (result.status === "failed") {
    job.summary.failed += 1;
    job.failureCount += 1;
    job.consecutiveFailures += 1;
  } else if (result.status === "skipped") {
    job.summary.skipped += 1;
    job.consecutiveFailures = 0;
  } else if (result.status === "cancelled") {
    job.summary.cancelled += 1;
  }
  persistJobs();
}

function evaluateRiskAfterResult(job: Job) {
  const risk = panelState.config.riskControls;
  if (job.failureCount >= risk.stopOnTotalFailures) {
    job.cancelRequested = true;
    job.cancelReason = `Stopped by risk control: total failures reached ${risk.stopOnTotalFailures}`;
    log(job, job.cancelReason);
  }
  if (job.consecutiveFailures >= risk.stopOnConsecutiveFailures) {
    job.cancelRequested = true;
    job.cancelReason = `Stopped by risk control: consecutive failures reached ${risk.stopOnConsecutiveFailures}`;
    log(job, job.cancelReason);
  }
}

function skippedResult(
  entry: ExecutionWallet,
  action: JobAction,
  amount: bigint,
  startedAt: number,
  error: string,
  round?: number
): JobResult {
  return {
    walletId: entry.id,
    index: entry.index,
    wallet: entry.wallet.address,
    label: entry.label,
    action,
    amount: amount.toString(),
    round,
    status: "skipped",
    error,
    durationMs: Date.now() - startedAt
  };
}

function failedResult(
  entry: ExecutionWallet,
  action: JobAction,
  amount: bigint,
  startedAt: number,
  error: unknown,
  round?: number,
  cancelled?: boolean
): JobResult {
  return {
    walletId: entry.id,
    index: entry.index,
    wallet: entry.wallet.address,
    label: entry.label,
    action,
    amount: amount.toString(),
    round,
    status: cancelled ? "cancelled" : "failed",
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - startedAt
  };
}

function assertJobNotCancelled(job: Job) {
  if (job.cancelRequested) {
    throw new Error(job.cancelReason || "Job cancelled");
  }
}

function log(job: Job, message: string) {
  const line = `[${new Date().toISOString()}] ${message}`;
  job.logs.push(line);
  if (job.logs.length > 500) job.logs.shift();
  persistJobs();
}

function saveJobReport(job: Job) {
  writeFileSync(resolve(reportsDir, `panel-job-${job.id}.json`), JSON.stringify(job, null, 2));
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload, null, 2));
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  shouldStop?: () => boolean,
  onResult?: (result: T, index: number) => void
) {
  const results: T[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, async () => {
    while (next < tasks.length) {
      if (shouldStop?.()) break;
      const taskIndex = next++;
      const result = await tasks[taskIndex]();
      results[taskIndex] = result;
      onResult?.(result, taskIndex);
    }
  });
  await Promise.all(workers);
  return results.filter((item) => item !== undefined);
}

function sampleWallets<T>(items: T[], count: number) {
  const cloned = [...items];
  for (let i = cloned.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cloned[i], cloned[j]] = [cloned[j], cloned[i]];
  }
  return cloned.slice(0, Math.min(count, cloned.length));
}

function positiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseOptionalBigInt(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return BigInt(text);
}

function sanitizeTimeOfDay(value: unknown) {
  const text = String(value ?? "").trim();
  return /^\d{2}:\d{2}$/.test(text) ? text : undefined;
}

function timeOfDayToMinutes(value?: string) {
  if (!value) return undefined;
  const [hours, minutes] = value.split(":").map((item) => Number(item));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  return hours * 60 + minutes;
}

function isWithinTimeWindow(now: Date, start?: string, end?: string) {
  const startMinutes = timeOfDayToMinutes(start);
  const endMinutes = timeOfDayToMinutes(end);
  if (startMinutes === undefined || endMinutes === undefined) return true;

  const chinaNow = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const currentMinutes = chinaNow.getHours() * 60 + chinaNow.getMinutes();
  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
}

async function waitForExecutionWindow(job: Job, options?: ExecutionWindow) {
  if (!options?.timeStart || !options?.timeEnd) return;

  while (!isWithinTimeWindow(new Date(), options.timeStart, options.timeEnd)) {
    log(job, `Outside execution window ${options.timeStart}-${options.timeEnd}, waiting 30s`);
    await sleepWithCancel(30000, job);
  }
}

function randomIntBetween(min: number, max: number) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function waitRandomInterval(job: Job, options?: ExecutionWindow) {
  const min = Math.max(0, options?.intervalMinMs || 0);
  const max = Math.max(min, options?.intervalMaxMs || min);
  if (max <= 0) return;
  const waitMs = randomIntBetween(min, max);
  log(job, `Waiting ${waitMs}ms before next wallet`);
  await sleepWithCancel(waitMs, job);
}

function pickEffectiveAmountWei(config: PanelConfig, min: bigint, max: bigint) {
  const effectiveMin = min > 0n ? min : max;
  const effectiveMax = max >= effectiveMin ? max : effectiveMin;
  if (effectiveMin === effectiveMax) {
    validateAmountAgainstRisk(config, effectiveMin);
    return effectiveMin;
  }

  const effectiveMinNum = Number(effectiveMin);
  const effectiveMaxNum = Number(effectiveMax);
  const randomValue = Math.random() * (effectiveMaxNum - effectiveMinNum) + effectiveMinNum;
  const candidate = BigInt(Math.floor(randomValue));
  validateAmountAgainstRisk(config, candidate);
  return candidate;
}

function sanitizeGroupName(value: string) {
  return value.trim().slice(0, 32);
}

function uniqueSorted(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
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

async function sleepWithCancel(ms: number, job: Job) {
  const step = 500;
  let remaining = ms;
  while (remaining > 0) {
    assertJobNotCancelled(job);
    await sleep(Math.min(step, remaining));
    remaining -= step;
  }
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findMaxBorrowForDeposit(
  connected: Contract,
  tokenAddress: string,
  depositAmountWei: bigint,
  theoreticalLimit: bigint
) {
  if (theoreticalLimit <= 0n) return 0n;
  if (!(await canDepositAndBorrow(connected, tokenAddress, depositAmountWei, 1n))) return 0n;

  let low = 1n;
  let high = theoreticalLimit;

  if (await canDepositAndBorrow(connected, tokenAddress, depositAmountWei, high)) {
    return high;
  }

  for (let i = 0; i < 48; i++) {
    if (high <= low + 1n) break;
    const mid = (low + high) / 2n;
    if (mid <= 0n) break;
    if (await canDepositAndBorrow(connected, tokenAddress, depositAmountWei, mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}

async function canDepositAndBorrow(
  connected: Contract,
  tokenAddress: string,
  depositAmountWei: bigint,
  debtAmountWei: bigint
) {
  if (debtAmountWei <= 0n) return false;
  try {
    await connected.depositAndBorrow.staticCall(tokenAddress, depositAmountWei, debtAmountWei);
    return true;
  } catch {
    return false;
  }
}

function startServer(httpServer: ReturnType<typeof createServer>, port: number) {
  httpServer.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Stop the existing panel instance before starting a new one.`);
      process.exit(1);
    }
    throw error;
  });

  httpServer.listen(port, () => {
    const address = httpServer.address() as AddressInfo | null;
    console.log(`Market maker panel is running at http://127.0.0.1:${address?.port || port}`);
  });
}

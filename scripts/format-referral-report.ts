import { existsSync, readFileSync } from "node:fs";
import * as XLSX from "xlsx";

type ReportNode = {
  label: string;
  parentLabel?: string;
  wallet?: {
    index?: number;
    address?: string;
  };
  invitationCode?: string;
  boundReferrer?: string | null;
  bindStatus?: string;
  bindError?: string;
  buyHash?: string;
  buyStatus?: string;
  buyError?: string;
  boughtTokenAmount?: string;
  sellHash?: string;
  sellStatus?: string;
  sellError?: string;
  sellTokenAmount?: string;
  lifetimeTotal?: string;
  lifetimeTrade?: string;
  lifetimeReferral?: string;
  lifetimeMarket?: string;
  todayTotal?: string;
  hashpower?: string;
  subtreePoints?: string;
  largestBranchPoints?: string;
  networkTotal?: string;
  hashpowerShare?: string;
  directCount?: number;
  totalSubtreeCount?: number;
  updatedAt?: string;
  pointsRefreshError?: string;
};

const reportBase = process.argv[2] || process.env.REFERRAL_REPORT_BASE || "";
const intervalMs = Number(process.env.REFERRAL_REPORT_FORMAT_INTERVAL_MS || "10000");
const rounds = Number(process.env.REFERRAL_REPORT_FORMAT_ROUNDS || "180");
const targetSymbol = process.env.REFERRAL_TARGET_SYMBOL || "TST";
const targetDecimals = Number(process.env.REFERRAL_TARGET_DECIMALS || "18");

if (!reportBase) {
  throw new Error("Usage: tsx scripts/format-referral-report.ts reports/referral-plan-YYYYMMDD-HHMMSS");
}

let lastJson = "";

for (let round = 1; round <= rounds; round++) {
  const jsonPath = `${reportBase}.json`;
  if (existsSync(jsonPath)) {
    const json = readFileSync(jsonPath, "utf8");
    if (json !== lastJson) {
      lastJson = json;
      const report = JSON.parse(json) as { generatedAt?: string; nodes: ReportNode[] };
      writeChineseWorkbook(report.nodes, report.generatedAt);
      console.log(`Formatted ${reportBase}.xlsx (${round}/${rounds})`);
    }
  }

  if (round < rounds) await sleep(intervalMs);
}

function writeChineseWorkbook(items: ReportNode[], generatedAt?: string) {
  const rows = items.map((node) => {
    const parent = items.find((item) => item.label === node.parentLabel);
    const tradePoints = toNumberText(node.lifetimeTrade || node.lifetimeTotal);
    const referralPoints = toNumberText(node.hashpower || node.lifetimeReferral);
    const subtreePoints = toNumberText(node.subtreePoints || node.lifetimeMarket);
    const branchDiffPoints = subtractPoints(node.subtreePoints || node.lifetimeMarket, node.largestBranchPoints);
    return {
      "钱包角色": node.label,
      "钱包序号": node.wallet?.index ?? "",
      "钱包地址": node.wallet?.address || "",
      "上级角色": node.parentLabel || "无",
      "上级钱包地址": parent?.wallet?.address || "",
      "邀请码": node.invitationCode || "",
      "绑定状态": statusText(node.bindStatus),
      "已绑定邀请人": node.boundReferrer || "",
      "直接邀请人数": node.directCount ?? "",
      "团队总人数": node.totalSubtreeCount ?? "",
      "个人交易积分": tradePoints,
      "邀请/团队积分(算力)": referralPoints,
      "团队总交易积分": subtreePoints,
      "最大分支积分": toNumberText(node.largestBranchPoints),
      "团队总交易积分-最大分支积分": branchDiffPoints,
      "全网积分": toNumberText(node.networkTotal),
      "算力占比%": toNumberText(node.hashpowerShare),
      "今日积分": toNumberText(node.todayTotal),
      "积分主要来源": dominantSource(tradePoints, referralPoints, subtreePoints),
      "买入状态": statusText(node.buyStatus),
      "买入交易哈希": node.buyHash || "",
      [`买入${targetSymbol}数量`]: formatTokenAmount(node.boughtTokenAmount),
      "卖出状态": statusText(node.sellStatus),
      "卖出交易哈希": node.sellHash || "",
      [`卖出${targetSymbol}数量`]: formatTokenAmount(node.sellTokenAmount),
      "更新时间": formatDateTime(node.updatedAt),
      "绑定错误": node.bindError || "",
      "买入错误": node.buyError || "",
      "卖出错误": node.sellError || "",
      "积分刷新错误": node.pointsRefreshError || ""
    };
  });

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 10 },
    { wch: 10 },
    { wch: 44 },
    { wch: 10 },
    { wch: 44 },
    { wch: 14 },
    { wch: 16 },
    { wch: 44 },
    { wch: 12 },
    { wch: 12 },
    { wch: 16 },
    { wch: 20 },
    { wch: 18 },
    { wch: 16 },
    { wch: 24 },
    { wch: 14 },
    { wch: 12 },
    { wch: 16 },
    { wch: 18 },
    { wch: 12 },
    { wch: 68 },
    { wch: 22 },
    { wch: 12 },
    { wch: 68 },
    { wch: 22 },
    { wch: 20 },
    { wch: 26 },
    { wch: 26 },
    { wch: 26 },
    { wch: 26 }
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, "推荐积分明细");
  XLSX.utils.book_append_sheet(workbook, buildSummarySheet(items, generatedAt), "汇总");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["字段", "说明"],
      ["个人交易积分", "新版接口取 lifetime_points；旧版接口取 lifetime_trade，来自钱包自己的买入/卖出交易。"],
      ["邀请/团队积分(算力)", "新版接口取 hashpower；旧版接口取 lifetime_referral，用来观察推荐计划给上级/团队带来的积分。"],
      ["团队总交易积分", "新版接口取 subtree_points，表示该钱包团队内累计贡献的交易积分。"],
      ["最大分支积分", "新版接口取 largest_branch_points，用来判断推荐计划是否按最大分支扣减或均衡计算。"],
      ["团队总交易积分-最大分支积分", "用团队总交易积分减去最大分支积分得到，便于直接观察剩余可计入的团队差值。"],
      ["积分主要来源", "根据个人交易积分、邀请/团队积分、团队总交易积分三列中最大值自动判断。"]
    ]),
    "字段说明"
  );
  XLSX.writeFile(workbook, `${reportBase}.xlsx`);
}

function buildSummarySheet(items: ReportNode[], generatedAt?: string) {
  const sum = (pick: (item: ReportNode) => string | undefined) =>
    items.reduce((total, item) => total + Number(pick(item) || 0), 0);
  return XLSX.utils.aoa_to_sheet([
    ["项目", "数值"],
    ["报表更新时间", formatDateTime(generatedAt)],
    ["钱包总数", items.length],
    ["买入已确认", items.filter((item) => item.buyStatus === "confirmed").length],
    ["卖出已确认", items.filter((item) => item.sellStatus === "confirmed").length],
    ["有个人交易积分的钱包", items.filter((item) => Number(item.lifetimeTrade || item.lifetimeTotal || 0) > 0).length],
    ["有邀请/团队积分的钱包", items.filter((item) => Number(item.hashpower || item.lifetimeReferral || 0) > 0).length],
    ["个人交易积分合计", toNumberText(String(sum((item) => item.lifetimeTrade || item.lifetimeTotal)))],
    ["邀请/团队积分合计", toNumberText(String(sum((item) => item.hashpower || item.lifetimeReferral)))],
    ["团队总交易积分合计", toNumberText(String(sum((item) => item.subtreePoints || item.lifetimeMarket)))],
    [
      "团队总交易积分-最大分支积分合计",
      toNumberText(
        String(
          items.reduce(
            (total, item) =>
              total + Math.max(0, Number(item.subtreePoints || item.lifetimeMarket || 0) - Number(item.largestBranchPoints || 0)),
            0
          )
        )
      )
    ]
  ]);
}

function toNumberText(value?: string) {
  if (!value) return "";
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(8).replace(/\.?0+$/, "") : value;
}

function subtractPoints(total?: string, branch?: string) {
  const totalNumber = Number(total || 0);
  const branchNumber = Number(branch || 0);
  if (!Number.isFinite(totalNumber) || !Number.isFinite(branchNumber)) return "";
  return toNumberText(String(Math.max(0, totalNumber - branchNumber)));
}

function dominantSource(trade: string, referral: string, subtree: string) {
  const sources = [
    { label: "个人交易所得", value: Number(trade || 0) },
    { label: "邀请/团队所得", value: Number(referral || 0) },
    { label: "团队贡献累计", value: Number(subtree || 0) }
  ].filter((item) => item.value > 0);
  if (!sources.length) return "暂无积分";
  sources.sort((a, b) => b.value - a.value);
  if (sources.length > 1 && Math.abs(sources[0].value - sources[1].value) < 0.000001) return "混合";
  return sources[0].label;
}

function statusText(status?: string) {
  const map: Record<string, string> = {
    bound_now: "本次绑定成功",
    already_bound_parent: "已绑定到指定上级",
    already_bound_other: "已绑定到其他上级",
    bind_returned: "绑定接口已返回",
    retrying: "补跑中",
    confirmed: "已确认",
    failed: "失败"
  };
  return status ? map[status] || status : "";
}

function formatTokenAmount(raw?: string) {
  if (!raw) return "";
  try {
    const base = 10n ** BigInt(targetDecimals);
    const value = BigInt(raw);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(targetDecimals, "0").slice(0, 6);
    return `${whole}.${fraction}`.replace(/\.?0+$/, "");
  } catch {
    return raw;
  }
}

function formatDateTime(value?: string) {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

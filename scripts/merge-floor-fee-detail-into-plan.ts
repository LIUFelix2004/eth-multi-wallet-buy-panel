import { readFileSync } from "node:fs";
import XLSX from "xlsx";

type FeeDetailReport = {
  summary: {
    walletCount: number;
    amountUsdt: string;
    concurrency: number;
    reserveBeforeRaw: string;
    reserveAfterRaw: string;
    reserveDeltaRaw: string;
    floorBeforeRaw: string;
    floorAfterRaw: string;
    floorDeltaRaw: string;
    expectedFeeRaw: string;
    expectedReservePartRaw: string;
    confirmed: number;
    failed: number;
    reservePartMatches: boolean;
    floorNonDecreasing: boolean;
  };
  results: Array<{
    status: "confirmed" | "failed";
    netInForCurveRaw?: string;
    reservePartRaw?: string;
  }>;
};

const planPath = process.argv[2] || "reports/地板价机制并发测试（最核心）.xlsx";
const detailPath = process.argv[3] || "reports/floor-fee-injection-detail-20260525T110844.json";

const workbook = XLSX.readFile(planPath);
const detail = JSON.parse(readFileSync(detailPath, "utf8")) as FeeDetailReport;

const reserveDecimals = 18;
const netInForCurveSum = detail.results.reduce((sum, item) => sum + BigInt(item.netInForCurveRaw || "0"), 0n);
const reservePartSum = detail.results.reduce((sum, item) => sum + BigInt(item.reservePartRaw || "0"), 0n);
const reserveDelta = BigInt(detail.summary.reserveDeltaRaw);
const injectedByDelta = reserveDelta - netInForCurveSum;
const exactMatch = injectedByDelta === reservePartSum;

updateScenarioSheet();
updateValidationSheet();
updateExecutionSheet();

XLSX.writeFile(workbook, planPath);
console.log(`Updated ${planPath} with F2 detail from ${detailPath}`);

function updateScenarioSheet() {
  const sheet = workbook.Sheets["测试场景"];
  if (!sheet) return;
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });
  for (const row of rows) {
    if (row["场景ID"] !== "F2") continue;
    row["执行结果"] = exactMatch && detail.summary.floorNonDecreasing ? "通过" : "部分通过";
    row["备注"] =
      `已用 F2 专项实验回填：confirmed=${detail.summary.confirmed}, failed=${detail.summary.failed} | ` +
      `reserveDelta=${format(reserveDelta)} | netInForCurveSum=${format(netInForCurveSum)} | ` +
      `reservePartSum=${format(reservePartSum)} | reserveDelta-net=${format(injectedByDelta)} | ` +
      `手续费注入精确匹配=${exactMatch ? "是" : "否"} | floorNonDecreasing=${detail.summary.floorNonDecreasing ? "是" : "否"}`;
  }
  workbook.Sheets["测试场景"] = XLSX.utils.json_to_sheet(rows);
}

function updateValidationSheet() {
  const sheet = workbook.Sheets["验证点"];
  if (!sheet) return;
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });
  for (const row of rows) {
    if (row["验证项"] === "手续费累加无精度损失") {
      row["结果"] = exactMatch ? "通过" : "失败";
      row["备注"] =
        `F2专项实测：reserveDelta-netInForCurve=${format(injectedByDelta)}，reservePartSum=${format(reservePartSum)}，` +
        `二者${exactMatch ? "一致" : "不一致"}。`;
    }
    if (row["验证项"] === "地板价只涨不跌") {
      row["备注"] = `${row["备注"]} F2专项：floorBefore=${format(BigInt(detail.summary.floorBeforeRaw))}，floorAfter=${format(BigInt(detail.summary.floorAfterRaw))}。`.trim();
    }
  }
  workbook.Sheets["验证点"] = XLSX.utils.json_to_sheet(rows);
}

function updateExecutionSheet() {
  const sheet = workbook.Sheets["执行汇总"];
  if (!sheet) return;
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });
  for (const row of rows) {
    if (row["场景ID"] !== "F2") continue;
    row["状态"] = exactMatch && detail.summary.floorNonDecreasing ? "通过" : "部分通过";
    row["Reserve前"] = format(BigInt(detail.summary.reserveBeforeRaw));
    row["Reserve后"] = format(BigInt(detail.summary.reserveAfterRaw));
    row["Floor前"] = format(BigInt(detail.summary.floorBeforeRaw));
    row["Floor后"] = format(BigInt(detail.summary.floorAfterRaw));
    row["地板价不跌"] = detail.summary.floorNonDecreasing ? "通过" : "失败";
    row["预期手续费注入"] = format(reservePartSum);
    row["说明"] =
      `F2专项回填：reserveDelta=${format(reserveDelta)}，netInForCurveSum=${format(netInForCurveSum)}，` +
      `reservePartSum=${format(reservePartSum)}，delta-net=${format(injectedByDelta)}。`;
  }
  workbook.Sheets["执行汇总"] = XLSX.utils.json_to_sheet(rows);
}

function format(value: bigint) {
  return XLSX.SSF.format("0.################", Number(value) / 1e18);
}

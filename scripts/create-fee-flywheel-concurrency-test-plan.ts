import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const reportName = process.argv[2] || "手续费飞轮并发测试";
const targetToken = process.env.REFERRAL_TARGET_TOKEN_ADDRESS || "0x4ffa71de6e3ed3928c16aeaad0b8644fdef68b46";
const outputBase = `reports/${reportName}`;
const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

const overviewRows = [
  { 字段: "表格名称", 内容: reportName },
  { 字段: "生成时间", 内容: generatedAt },
  { 字段: "测试目标", 内容: "验证手续费飞轮在高频并发交易下的累积、写入竞态与地板储备/地板价链式更新一致性" },
  { 字段: "买入目标 Token", 内容: targetToken },
  { 字段: "关注重点", 内容: "Buy 1.25% + Sell 3% 手续费累积、reservePart 注入精度、100笔并发计入完整性、链式更新状态一致" },
  { 字段: "执行状态", 内容: "待开始" }
];

const caseRows = [
  {
    场景ID: "W1",
    场景名称: "高频并发交易（模拟真实热门代币）",
    前置条件: "买卖双方钱包已就绪；手续费参数已知：Buy 1.25%、Sell 3%；地板储备与地板价可读",
    操作步骤: "高频并发触发多笔 buy + sell，统计每笔手续费、reservePart 与地板储备变化",
    预期结果: "Buy 1.25% + Sell 3% 的手续费累积正确；注入地板储备的比例精确",
    核心验证点: "手续费计算正确；reservePart 注入比例正确；地板价状态一致",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "W2",
    场景名称: "并发交易时手续费写入竞态",
    前置条件: "100 笔并发交易钱包池可用；目标 token 允许连续并发 buy；合约事件可读取",
    操作步骤: "触发 100 笔并发交易，逐笔核对手续费是否全部进入统计与链上状态",
    预期结果: "每笔手续费都必须被计入，不能丢失",
    核心验证点: "100 笔手续费全量记账；reservePart 汇总无丢失；失败样本可解释",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "W3",
    场景名称: "飞轮压测（手续费→地板储备→地板价更新）",
    前置条件: "地板储备、地板价、手续费事件链均可观测；支持并发链式状态更新",
    操作步骤: "在并发 buy/sell 下持续触发手续费注入，观察地板储备与地板价的链式更新",
    预期结果: "并发触发链式更新时状态一致，不出现地板储备/地板价错位",
    核心验证点: "链式状态一致；地板价不逆向异常；储备状态和事件累积一致",
    优先级: "高",
    执行结果: "",
    备注: ""
  }
];

const validationRows = [
  {
    验证项: "手续费累积正确",
    判定标准: "Buy 1.25% + Sell 3% 的手续费逐笔计算正确，汇总不偏差",
    数据来源: "Buy/Sell 事件、交易回执、buyFee/sellFee 配置",
    结果: "",
    备注: ""
  },
  {
    验证项: "地板储备注入比例精确",
    判定标准: "注入地板储备的 reservePart 与链上 reserve 增量/净流入关系一致",
    数据来源: "marketState.reserve、Buy/Sell 事件、reserveShare",
    结果: "",
    备注: ""
  },
  {
    验证项: "100笔并发手续费不丢失",
    判定标准: "100 笔并发交易中，每笔手续费都被计入统计，不能丢失",
    数据来源: "事件条数、成功回执、汇总统计",
    结果: "",
    备注: ""
  },
  {
    验证项: "飞轮链式更新一致",
    判定标准: "手续费→地板储备→地板价 更新链在并发下保持状态一致",
    数据来源: "marketState.reserve、marketState.floorPrice、事件序列",
    结果: "",
    备注: ""
  }
];

const evidenceRows = [
  { 字段: "目标 Token", 值: targetToken },
  { 字段: "链上排序依据", 值: "blockNumber -> transactionIndex -> logIndex" },
  { 字段: "建议记录字段", 值: "wallet, txHash, action, amountIn, grossOut, amountOut, fee, reservePart, netInForCurve, reserveBefore, reserveAfter, floorPriceBefore, floorPriceAfter, revertReason" },
  { 字段: "建议输出", 值: "原始明细 JSON + 汇总 XLSX + 高频并发失败样本日志 + 事件与状态对账结果" }
];

const workbook = XLSX.utils.book_new();
const overviewSheet = XLSX.utils.json_to_sheet(overviewRows);
overviewSheet["!cols"] = [{ wch: 18 }, { wch: 110 }];
const caseSheet = XLSX.utils.json_to_sheet(caseRows);
caseSheet["!cols"] = [
  { wch: 10 },
  { wch: 30 },
  { wch: 38 },
  { wch: 44 },
  { wch: 54 },
  { wch: 40 },
  { wch: 8 },
  { wch: 12 },
  { wch: 28 }
];
const validationSheet = XLSX.utils.json_to_sheet(validationRows);
validationSheet["!cols"] = [
  { wch: 22 },
  { wch: 58 },
  { wch: 36 },
  { wch: 12 },
  { wch: 30 }
];
const evidenceSheet = XLSX.utils.json_to_sheet(evidenceRows);
evidenceSheet["!cols"] = [{ wch: 18 }, { wch: 128 }];

XLSX.utils.book_append_sheet(workbook, overviewSheet, "测试概览");
XLSX.utils.book_append_sheet(workbook, caseSheet, "测试场景");
XLSX.utils.book_append_sheet(workbook, validationSheet, "验证点");
XLSX.utils.book_append_sheet(workbook, evidenceSheet, "取证要求");

mkdirSync(dirname(`${outputBase}.xlsx`), { recursive: true });
XLSX.writeFile(workbook, `${outputBase}.xlsx`);

writeFileSync(
  `${outputBase}.json`,
  JSON.stringify(
    {
      reportName,
      generatedAt,
      targetToken,
      overview: overviewRows,
      scenarios: caseRows,
      validations: validationRows,
      evidence: evidenceRows
    },
    null,
    2
  )
);

console.log(`Created ${outputBase}.xlsx`);

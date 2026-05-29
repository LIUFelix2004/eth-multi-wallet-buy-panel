import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const reportName = process.argv[2] || "无清算借贷并发测试";
const targetToken = process.env.REFERRAL_TARGET_TOKEN_ADDRESS || "0x4ffa71de6e3ed3928c16aeaad0b8644fdef68b46";
const outputBase = `reports/${reportName}`;
const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

const overviewRows = [
  { 字段: "表格名称", 内容: reportName },
  { 字段: "生成时间", 内容: generatedAt },
  { 字段: "测试目标", 内容: "验证无清算借贷在并发借贷、市场波动与 looping 嵌套操作中的额度正确性与合约边界稳定性" },
  { 字段: "买入目标 Token", 内容: targetToken },
  { 字段: "关注重点", 内容: "借贷额度按 floor_price 计算、无清算假设下仓位稳定、loop 并发不超额借出" },
  { 字段: "执行状态", 内容: "待开始" }
];

const caseRows = [
  {
    场景ID: "B1",
    场景名称: "100个钱包同时发起借贷（按地板价计算额度）",
    前置条件: "100 个钱包持有足额 token 作为抵押；地板价可读取；借贷储备池余额充足",
    操作步骤: "100 个钱包并发借贷，按地板价 × token 数量计算理论额度，对比链上实际借出金额",
    预期结果: "每笔借贷额度计算正确；并发借贷后总借出量不能超过储备上限",
    核心验证点: "额度公式正确；总借出量受上限约束；失败回执可解释",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "B2",
    场景名称: "借贷 + 同时 Sell（市场价波动）",
    前置条件: "存在有效借贷仓位；允许并发 sell 引发市场价格波动；仓位状态接口可读取",
    操作步骤: "一组钱包借贷，另一组钱包同步 sell，观测仓位状态、地板价与借款状态",
    预期结果: "不会触发清算；仓位状态数据前后一致，无异常变更",
    核心验证点: "无清算触发；仓位状态字段稳定；价格波动不影响已建仓位",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "B3",
    场景名称: "Looping 循环借贷并发",
    前置条件: "多个钱包具备初始抵押或首轮买入资金；合约支持借→买→再借流程",
    操作步骤: "多个钱包同时做 Loop（借→买→再借），持续打满并发直到触达额度或合约边界",
    预期结果: "合约正确处理嵌套并发；不能出现额度计算错误导致的超额借出；达到上限时行为明确",
    核心验证点: "Loop 上限限制；并发嵌套稳定性；无超额借出",
    优先级: "高",
    执行结果: "",
    备注: ""
  }
];

const validationRows = [
  {
    验证项: "借贷额度计算正确",
    判定标准: "借贷额度 = floor_price × token数量，并发下计算不能出错",
    数据来源: "地板价、抵押 token 数量、借款回执、quoteBorrow/链上事件",
    结果: "",
    备注: ""
  },
  {
    验证项: "无清算",
    判定标准: "市场价大幅波动时借贷仓位状态不变，不触发清算或被动平仓",
    数据来源: "仓位状态接口、借贷记录、并发 sell 回执",
    结果: "",
    备注: ""
  },
  {
    验证项: "Looping 上限行为正确",
    判定标准: "Looping 上限存在合约级限制；并发打满时行为正确且可解释",
    数据来源: "借贷/买入/再借回执、失败错误码、额度上限状态",
    结果: "",
    备注: ""
  },
  {
    验证项: "总借出量不超额",
    判定标准: "并发借贷与 looping 后总借出量不能超过储备或风控上限",
    数据来源: "借贷池余额、借出总量、borrowInfo/marketInfo",
    结果: "",
    备注: ""
  }
];

const evidenceRows = [
  { 字段: "目标 Token", 值: targetToken },
  { 字段: "链上排序依据", 值: "blockNumber -> transactionIndex -> logIndex" },
  { 字段: "建议记录字段", 值: "wallet, txHash, blockNumber, transactionIndex, collateralAmount, floorPrice, theoreticalBorrowLimit, actualBorrowOut, totalDebtBefore, totalDebtAfter, cashReserveBefore, cashReserveAfter, positionBefore, positionAfter, revertReason" },
  { 字段: "建议输出", 值: "原始明细 JSON + 汇总 XLSX + borrow/loop 失败样本日志 + 仓位状态快照" }
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

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const reportName = process.argv[2] || "地板价机制并发测试（最核心）";
const targetToken = process.env.REFERRAL_TARGET_TOKEN_ADDRESS || "0x4ffa71de6e3ed3928c16aeaad0b8644fdef68b46";
const outputBase = `reports/${reportName}`;
const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

const overviewRows = [
  { 字段: "表格名称", 内容: reportName },
  { 字段: "生成时间", 内容: generatedAt },
  { 字段: "测试目标", 内容: "验证地板价机制在并发卖出与手续费注入场景下的稳健性、兑付能力与边界保护" },
  { 字段: "买卖目标 Token", 内容: targetToken },
  { 字段: "关注重点", 内容: "地板价只涨不跌、手续费注入竞态、极端卖压兑付稳定性、失败回执可解释" },
  { 字段: "执行状态", 内容: "待开始" }
];

const caseRows = [
  {
    场景ID: "F1",
    场景名称: "大量并发 Sell 压到地板价附近",
    前置条件: "钱包持有足够 token；地板储备充足；接近地板价前的 floor reserve / floor price 已记录",
    操作步骤: "大量钱包并发卖出，将价格压到地板价附近，收集每笔 sell 回执、兑付金额、地板储备变化",
    预期结果: "地板储备能正确兑付所有有效请求；地板价本身不能下降",
    核心验证点: "地板价不降低；兑付金额合理；地板储备扣减与支付一致",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "F2",
    场景名称: "并发交易产生手续费并注入地板储备",
    前置条件: "合约已开启手续费与地板储备注入逻辑；注入比例可确定；交易明细可提取手续费字段",
    操作步骤: "发起多笔并发买卖交易，统计每笔手续费与应注入地板储备金额，再与链上实际储备增量比对",
    预期结果: "注入总量 == sum(每笔手续费 × 注入比例)，不能出现竞态丢失或重复累计",
    核心验证点: "手续费累加无精度损失；注入总量精确；同区块并发下注入顺序合理",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "F3",
    场景名称: "极端卖压下并发 Sell（100个钱包同时砸盘）",
    前置条件: "100 个钱包已持有可卖 token；gas 充足；极端卖压参数已确认",
    操作步骤: "100 个钱包同时发起 sell，观察地板价、储备变化、成功失败分布与失败原因",
    预期结果: "地板价守住；合约能正常兑付或以明确错误码拒绝，不能 panic 或出现不可解释 revert",
    核心验证点: "地板价守住；失败回执具备明确错误码；合约无崩溃",
    优先级: "高",
    执行结果: "",
    备注: ""
  }
];

const validationRows = [
  {
    验证项: "地板价只涨不跌",
    判定标准: "任何并发操作后 floor_price 不能降低",
    数据来源: "每笔交易前后 floor_price、区块顺序明细",
    结果: "",
    备注: ""
  },
  {
    验证项: "手续费累加无精度损失",
    判定标准: "注入总量 == sum(每笔手续费 × 注入比例)，且无 rounding drift 超限",
    数据来源: "手续费明细、地板储备增量、链上事件",
    结果: "",
    备注: ""
  },
  {
    验证项: "极端并发下合约不崩溃",
    判定标准: "高并发 sell 下合约不 panic；失败 tx 必须有明确错误码或可解释 revert reason",
    数据来源: "交易回执、错误日志、revert data",
    结果: "",
    备注: ""
  },
  {
    验证项: "地板储备兑付一致性",
    判定标准: "储备支付总额与各笔 sell 实际兑付金额之和一致",
    数据来源: "链上支付事件、储备余额变化",
    结果: "",
    备注: ""
  }
];

const evidenceRows = [
  { 字段: "目标 Token", 值: targetToken },
  { 字段: "链上排序依据", 值: "blockNumber -> transactionIndex -> logIndex" },
  { 字段: "建议记录字段", 值: "wallet, txHash, blockNumber, transactionIndex, sellAmount, payoutAmount, floorPriceBefore, floorPriceAfter, floorReserveBefore, floorReserveAfter, feeAmount, injectedReserveAmount, revertReason" },
  { 字段: "建议输出", 值: "原始明细 JSON + 汇总 XLSX + 异常失败样本日志 + 同区块竞态样本" }
];

const workbook = XLSX.utils.book_new();

const overviewSheet = XLSX.utils.json_to_sheet(overviewRows);
overviewSheet["!cols"] = [{ wch: 18 }, { wch: 110 }];

const caseSheet = XLSX.utils.json_to_sheet(caseRows);
caseSheet["!cols"] = [
  { wch: 10 },
  { wch: 28 },
  { wch: 36 },
  { wch: 42 },
  { wch: 52 },
  { wch: 40 },
  { wch: 8 },
  { wch: 12 },
  { wch: 28 }
];

const validationSheet = XLSX.utils.json_to_sheet(validationRows);
validationSheet["!cols"] = [
  { wch: 20 },
  { wch: 58 },
  { wch: 32 },
  { wch: 12 },
  { wch: 28 }
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

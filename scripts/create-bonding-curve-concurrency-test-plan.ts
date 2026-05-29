import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as XLSX from "xlsx";

const reportName = process.argv[2] || "Bonding Curve 定价并发测试";
const targetToken = process.env.REFERRAL_TARGET_TOKEN_ADDRESS || "0x4ffa71de6e3ed3928c16aeaad0b8644fdef68b46";
const outputBase = `reports/${reportName}`;
const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

const overviewRows = [
  { 字段: "表格名称", 内容: reportName },
  { 字段: "生成时间", 内容: generatedAt },
  { 字段: "测试目标", 内容: "验证 Bonding Curve 在并发买入场景下的定价正确性、供应量一致性与边界保护" },
  { 字段: "买入目标 Token", 内容: targetToken },
  { 字段: "关注重点", 内容: "链上顺序定价、同 slot 并发合理性、顶部边界拒单、无超发" },
  { 字段: "执行状态", 内容: "待开始" }
];

const caseRows = [
  {
    场景ID: "S1",
    场景名称: "10个钱包同时买相同数量",
    前置条件: "10 个钱包余额充足；目标 token 可正常买入；每个钱包买入数量完全一致",
    操作步骤: "10 个钱包并发提交买单，观察链上最终排序与成交结果",
    预期结果: "每人成交价不同，按先到先得沿曲线递增；不能出现后成交价格低于先成交价格",
    核心验证点: "价格单调性；同数量并发买入是否体现曲线递增",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "S2",
    场景名称: "快速连续大量买入",
    前置条件: "钱包群余额充足；可连续发起多轮高频买单",
    操作步骤: "在短时间内连续发起大量买入，按链上顺序收集成交价格",
    预期结果: "价格沿曲线单调递增，不能出现价格倒退",
    核心验证点: "跨 slot / 同 slot 的价格序列必须单调上升",
    优先级: "高",
    执行结果: "",
    备注: ""
  },
  {
    场景ID: "S3",
    场景名称: "买到曲线顶部后继续并发买",
    前置条件: "已将 supply 推进到接近曲线顶部；剩余可买空间可控",
    操作步骤: "达到顶部后继续并发提交买单，统计成功与失败回执",
    预期结果: "所有超边界买单都返回正确边界错误；不能超发；不能出现部分错误类型异常漂移",
    核心验证点: "顶部边界错误一致性；无超发；失败回执可解释",
    优先级: "高",
    执行结果: "",
    备注: ""
  }
];

const validationRows = [
  {
    验证项: "价格单调性",
    判定标准: "tx 按链上顺序排列后，价格必须严格递增",
    数据来源: "链上交易回执、事件日志、区块/交易索引",
    结果: "",
    备注: ""
  },
  {
    验证项: "Supply 一致性",
    判定标准: "并发成交后的 supply 总量 == 各笔 Mint 数量之和",
    数据来源: "合约总 supply、Mint 事件汇总",
    结果: "",
    备注: ""
  },
  {
    验证项: "无价格操纵漏洞",
    判定标准: "同一 slot 内多笔 tx 的定价合理，不存在倒挂、插队获低价或异常跳变",
    数据来源: "同 slot 交易序列、成交单价、日志对比",
    结果: "",
    备注: ""
  },
  {
    验证项: "顶部边界保护",
    判定标准: "超出曲线顶部后全部返回正确边界错误，且没有超发",
    数据来源: "失败回执、revert reason、合约 supply",
    结果: "",
    备注: ""
  }
];

const evidenceRows = [
  { 字段: "目标 Token", 值: targetToken },
  { 字段: "链上排序依据", 值: "blockNumber -> transactionIndex -> logIndex" },
  { 字段: "建议记录字段", 值: "wallet, txHash, blockNumber, transactionIndex, gasUsed, amountIn, mintedAmount, avgPrice, slot/block, revertReason" },
  { 字段: "建议输出", 值: "原始明细 JSON + 汇总 XLSX + 异常样本日志" }
];

const workbook = XLSX.utils.book_new();

const overviewSheet = XLSX.utils.json_to_sheet(overviewRows);
overviewSheet["!cols"] = [{ wch: 18 }, { wch: 110 }];

const caseSheet = XLSX.utils.json_to_sheet(caseRows);
caseSheet["!cols"] = [
  { wch: 10 },
  { wch: 24 },
  { wch: 34 },
  { wch: 36 },
  { wch: 48 },
  { wch: 34 },
  { wch: 8 },
  { wch: 12 },
  { wch: 24 }
];

const validationSheet = XLSX.utils.json_to_sheet(validationRows);
validationSheet["!cols"] = [
  { wch: 18 },
  { wch: 50 },
  { wch: 28 },
  { wch: 12 },
  { wch: 24 }
];

const evidenceSheet = XLSX.utils.json_to_sheet(evidenceRows);
evidenceSheet["!cols"] = [{ wch: 18 }, { wch: 120 }];

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

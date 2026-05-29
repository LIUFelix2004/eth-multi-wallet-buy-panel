const state = {
  jobs: [],
  groups: [],
  wallets: [],
  selectedWalletIds: new Set(),
  selectedJobId: null,
  activeJobId: null,
  walletPage: 1,
  walletPageSize: 20,
  walletViewMode: "compact",
  expandedWalletIds: new Set(),
  marketAction: "buy",
  assetMeta: {
    reserveSymbol: "JU",
    reserveDecimals: 18,
    tokenSymbol: "TOKEN",
    tokenDecimals: 18
  }
};

let pendingConfirmAction = null;

const elements = {
  walletCount: document.querySelector("#walletCount"),
  activeJob: document.querySelector("#activeJob"),
  activeJobDot: document.querySelector("#activeJobDot"),
  activeJobStat: document.querySelector("#activeJobStat"),
  walletTableBody: document.querySelector("#walletTableBody"),
  jobsList: document.querySelector("#jobsList"),
  jobSummary: document.querySelector("#jobSummary"),
  jobLogs: document.querySelector("#jobLogs"),
  jobLogMeta: document.querySelector("#jobLogMeta"),
  toast: document.querySelector("#toast"),
  selectionSummary: document.querySelector("#selectionSummary"),
  groupFilterSelect: document.querySelector("#groupFilterSelect"),
  groupAssignSelect: document.querySelector("#groupAssignSelect"),
  confirmModal: document.querySelector("#confirmModal"),
  confirmModalContent: document.querySelector("#confirmModalContent"),
  walletPaginationMeta: document.querySelector("#walletPaginationMeta"),
  compactModeButton: document.querySelector("#compactModeButton"),
  detailModeButton: document.querySelector("#detailModeButton"),
  marketAddressCount: document.querySelector("#marketAddressCount"),
  marketAddressSummary: document.querySelector("#marketAddressSummary"),
  marketActionHint: document.querySelector("#marketActionHint"),
  marketUnitHint: document.querySelector("#marketUnitHint"),
  marketAmountHint: document.querySelector("#marketAmountHint"),
  marketAmountMinLabel: document.querySelector("#marketAmountMinLabel"),
  marketAmountMaxLabel: document.querySelector("#marketAmountMaxLabel"),
  buyAmountLabel: document.querySelector("#buyAmountLabel"),
  sellAmountLabel: document.querySelector("#sellAmountLabel"),
  randomReserveKeepAmountLabel: document.querySelector("#randomReserveKeepAmountLabel"),
  randomTokenKeepAmountLabel: document.querySelector("#randomTokenKeepAmountLabel"),
  randomMaxSellAmountLabel: document.querySelector("#randomMaxSellAmountLabel"),
  configUnitHint: document.querySelector("#configUnitHint"),
  configPanel: document.querySelector("#configPanel"),
  riskPanel: document.querySelector("#riskPanel"),
  walletImportPanel: document.querySelector("#walletImportPanel"),
  walletGroupPanel: document.querySelector("#walletGroupPanel"),
  walletLabelPanel: document.querySelector("#walletLabelPanel"),
  runMarketActionButton: document.querySelector("#runMarketActionButton"),
  openWalletPanelButton: document.querySelector("#openWalletPanelButton")
};

const configFieldIds = [
  "rpcUrl",
  "marketContractAddress",
  "tokenAddress",
  "reserveTokenAddress",
  "deadlineSeconds",
  "receiptTimeoutMs",
  "defaultMaxConcurrency",
  "buyAmount",
  "sellAmount",
  "randomRounds",
  "randomIntervalMs",
  "randomWalletsPerRound",
  "randomMaxConcurrency",
  "randomBuyProbabilityBps",
  "randomReserveKeepAmount",
  "randomTokenKeepAmount",
  "randomMaxSellAmount",
  "randomSellDivisor"
];

const riskFieldMap = {
  riskMaxWalletsPerTask: "maxWalletsPerTask",
  riskMaxAmountWeiPerOrder: "maxAmountWeiPerOrder",
  riskMinNativeBalanceWei: "minNativeBalanceWei",
  riskMinReserveBalanceWei: "minReserveBalanceWei",
  riskMinTokenBalanceWei: "minTokenBalanceWei",
  riskMinReserveLeftWei: "minReserveLeftWei",
  riskMinTokenLeftWei: "minTokenLeftWei",
  riskStopOnTotalFailures: "stopOnTotalFailures",
  riskStopOnConsecutiveFailures: "stopOnConsecutiveFailures"
};

boot().catch((error) => showToast(error.message, true));

async function boot() {
  bindEvents();
  await loadState();
  await refreshWallets();
  await refreshJobs();
  setInterval(refreshJobs, 4000);
}

function bindEvents() {
  document.querySelector("#saveConfigButton").addEventListener("click", saveConfig);
  document.querySelector("#toggleConfigPanelButton").addEventListener("click", () => togglePanel("config"));
  document.querySelector("#toggleRiskPanelButton").addEventListener("click", () => togglePanel("risk"));
  document.querySelector("#toggleWalletImportPanelButton").addEventListener("click", () => toggleOpsPanel("import"));
  document.querySelector("#toggleWalletGroupPanelButton").addEventListener("click", () => toggleOpsPanel("group"));
  document.querySelector("#toggleWalletLabelPanelButton").addEventListener("click", () => toggleOpsPanel("label"));
  document.querySelector("#refreshWalletsButton").addEventListener("click", refreshWallets);
  document.querySelector("#refreshJobsButton").addEventListener("click", refreshJobs);
  document.querySelector("#importWalletsButton").addEventListener("click", importWallets);
  document.querySelector("#importGeneratedButton").addEventListener("click", importGenerated);
  document.querySelector("#clearWalletsButton").addEventListener("click", clearWallets);
  document.querySelector("#createGroupButton").addEventListener("click", createGroup);
  document.querySelector("#deleteGroupButton").addEventListener("click", deleteGroup);
  document.querySelector("#addGroupToSelectedButton").addEventListener("click", () => assignGroups("add"));
  document.querySelector("#replaceGroupForSelectedButton").addEventListener("click", () => assignGroups("replace"));
  document.querySelector("#removeGroupFromSelectedButton").addEventListener("click", () => assignGroups("remove"));
  document.querySelector("#applyBulkLabelButton").addEventListener("click", applyBulkLabel);
  document.querySelector("#selectAllWalletsButton").addEventListener("click", selectAllVisibleWallets);
  document.querySelector("#clearSelectionButton").addEventListener("click", clearSelection);
  document.querySelector("#selectEnabledWalletsButton").addEventListener("click", selectEnabledWallets);
  document.querySelector("#groupFilterSelect").addEventListener("change", () => {
    state.walletPage = 1;
    renderWallets();
  });
  document.querySelector("#walletPageSize").addEventListener("change", () => {
    state.walletPageSize = Number(document.querySelector("#walletPageSize").value || "20");
    state.walletPage = 1;
    renderWallets();
  });
  document.querySelector("#walletPrevPageButton").addEventListener("click", () => {
    state.walletPage = Math.max(1, state.walletPage - 1);
    renderWallets();
  });
  document.querySelector("#walletNextPageButton").addEventListener("click", () => {
    const { totalPages } = paginateWallets(visibleWallets());
    state.walletPage = Math.min(totalPages, state.walletPage + 1);
    renderWallets();
  });
  elements.compactModeButton.addEventListener("click", () => {
    state.walletViewMode = "compact";
    renderWallets();
  });
  elements.detailModeButton.addEventListener("click", () => {
    state.walletViewMode = "detail";
    renderWallets();
  });
  document.querySelector("#runBuyButton").addEventListener("click", runBatchBuy);
  document.querySelector("#runSellButton").addEventListener("click", runBatchSell);
  document.querySelector("#runRandomButton").addEventListener("click", runRandomTask);
  document.querySelector("#cancelJobButton").addEventListener("click", cancelActiveJob);
  document.querySelector("#closeConfirmModalButton").addEventListener("click", closeConfirmModal);
  document.querySelector("#cancelConfirmButton").addEventListener("click", closeConfirmModal);
  document.querySelector("#confirmSubmitButton").addEventListener("click", async () => {
    if (!pendingConfirmAction) return;
    const action = pendingConfirmAction;
    pendingConfirmAction = null;
    closeConfirmModal();
    await action();
  });

  document.querySelectorAll("[data-market-action]").forEach((button) => {
    button.addEventListener("click", () => {
      state.marketAction = button.getAttribute("data-market-action");
      syncMarketActionTabs();
      syncMarketActionHint();
    });
  });

  elements.runMarketActionButton.addEventListener("click", runSelectedMarketAction);
  elements.openWalletPanelButton.addEventListener("click", () => {
    document.querySelector("#walletPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  ["marketAmountMin", "marketAmountMax", "marketIntervalMin", "marketIntervalMax"].forEach((id) => {
    document.querySelector(`#${id}`)?.addEventListener("change", syncDerivedTaskInputs);
  });
}

async function loadState() {
  const response = await api("/api/state");
  const { config, groups, walletCount, activeJobId, jobs, assetMeta } = response;
  state.groups = groups || [];
  state.jobs = jobs || [];
  state.activeJobId = activeJobId || null;
  state.assetMeta = assetMeta || state.assetMeta;
  if (!state.selectedJobId && state.jobs.length > 0) state.selectedJobId = state.jobs[0].id;

  configFieldIds.forEach((id) => {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = config[id] ?? "";
  });

  document.querySelector("#buyAmount").value = fromBaseUnits(config.buyAmount || "0", state.assetMeta.reserveDecimals);
  document.querySelector("#sellAmount").value = fromBaseUnits(config.sellAmount || "0", state.assetMeta.tokenDecimals);
  document.querySelector("#randomReserveKeepAmount").value = fromBaseUnits(config.randomReserveKeepAmount || "0", state.assetMeta.reserveDecimals);
  document.querySelector("#randomTokenKeepAmount").value = fromBaseUnits(config.randomTokenKeepAmount || "0", state.assetMeta.tokenDecimals);
  document.querySelector("#randomMaxSellAmount").value = fromBaseUnits(config.randomMaxSellAmount || "0", state.assetMeta.tokenDecimals);

  Object.entries(riskFieldMap).forEach(([inputId, riskKey]) => {
    const input = document.querySelector(`#${inputId}`);
    if (input) input.value = config.riskControls?.[riskKey] ?? "";
  });

  document.querySelector("#buyTaskAmount").value = config.buyAmount || "";
  document.querySelector("#sellTaskAmount").value = config.sellAmount || "";
  document.querySelector("#buyTaskConcurrency").value = config.defaultMaxConcurrency || 1;
  document.querySelector("#sellTaskConcurrency").value = config.defaultMaxConcurrency || 1;
  document.querySelector("#randomTaskRounds").value = config.randomRounds || 1;
  document.querySelector("#randomTaskIntervalMs").value = config.randomIntervalMs || 60000;
  document.querySelector("#randomTaskWalletsPerRound").value = config.randomWalletsPerRound || 1;
  document.querySelector("#randomTaskMaxConcurrency").value = config.randomMaxConcurrency || 1;
  document.querySelector("#randomTaskBuyProbabilityBps").value = config.randomBuyProbabilityBps || 5000;
  document.querySelector("#randomTaskBuyAmount").value = config.buyAmount || "";
  document.querySelector("#randomTaskReserveKeepAmount").value = config.randomReserveKeepAmount || "";
  document.querySelector("#randomTaskTokenKeepAmount").value = config.randomTokenKeepAmount || "";
  document.querySelector("#randomTaskMaxSellAmount").value = config.randomMaxSellAmount || "";
  document.querySelector("#randomTaskSellDivisor").value = config.randomSellDivisor || 5;
  document.querySelector("#walletPageSize").value = String(state.walletPageSize);

  document.querySelector("#marketAmountMin").value = fromBaseUnits(config.buyAmount || "0", state.assetMeta.reserveDecimals);
  document.querySelector("#marketAmountMax").value = fromBaseUnits(config.sellAmount || config.buyAmount || "0", state.assetMeta.tokenDecimals);
  document.querySelector("#marketIntervalMin").value = Math.max(1, Math.floor((config.randomIntervalMs || 60000) / 1000));
  document.querySelector("#marketIntervalMax").value = Math.max(1, Math.floor((config.randomIntervalMs || 60000) / 1000));

  elements.walletCount.textContent = walletCount;
  elements.activeJob.textContent = state.activeJobId ? state.activeJobId.slice(0, 8) : "无";
  renderGroupSelects();
  renderJobs();
  syncMarketActionTabs();
  syncMarketActionHint();
  syncConfigUnitLabels();
  syncDerivedTaskInputs();
}

async function saveConfig() {
  const config = {};
  configFieldIds.forEach((id) => {
    config[id] = document.querySelector(`#${id}`).value.trim();
  });
  config.buyAmount = toBaseUnits(config.buyAmount, state.assetMeta.reserveDecimals);
  config.sellAmount = toBaseUnits(config.sellAmount, state.assetMeta.tokenDecimals);
  config.randomReserveKeepAmount = toBaseUnits(config.randomReserveKeepAmount, state.assetMeta.reserveDecimals);
  config.randomTokenKeepAmount = toBaseUnits(config.randomTokenKeepAmount, state.assetMeta.tokenDecimals);
  config.randomMaxSellAmount = toBaseUnits(config.randomMaxSellAmount, state.assetMeta.tokenDecimals);
  config.riskControls = {};
  Object.entries(riskFieldMap).forEach(([inputId, riskKey]) => {
    config.riskControls[riskKey] = document.querySelector(`#${inputId}`).value.trim();
  });
  await api("/api/config", { method: "POST", body: JSON.stringify({ config }) });
  showToast("配置已保存");
  await loadState();
}

async function refreshWallets() {
  const response = await api("/api/wallets?refresh=1");
  state.wallets = response.wallets || [];
  state.groups = response.groups || [];
  elements.walletCount.textContent = response.walletCount;
  renderGroupSelects();
  renderWallets();
}

function visibleWallets() {
  const selectedGroup = elements.groupFilterSelect.value;
  return state.wallets.filter((wallet) => !selectedGroup || wallet.groups.includes(selectedGroup));
}

function paginateWallets(wallets) {
  const totalItems = wallets.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / state.walletPageSize));
  state.walletPage = Math.min(state.walletPage, totalPages);
  const startIndex = (state.walletPage - 1) * state.walletPageSize;
  const items = wallets.slice(startIndex, startIndex + state.walletPageSize);
  return {
    items,
    page: state.walletPage,
    totalPages,
    totalItems,
    start: totalItems === 0 ? 0 : startIndex + 1,
    end: totalItems === 0 ? 0 : startIndex + items.length
  };
}

function renderWallets() {
  const allWallets = visibleWallets();
  const { items: wallets, page, totalPages, totalItems, start, end } = paginateWallets(allWallets);
  elements.walletTableBody.innerHTML = wallets.map(renderWalletRow).join("");
  bindWalletRowEvents();
  elements.walletPaginationMeta.textContent =
    totalItems === 0 ? "第 0 / 0 页" : `第 ${page} / ${totalPages} 页，显示 ${start}-${end} / ${totalItems}`;
  updateSelectionSummary();
  syncModeButtons();
  updateMarketAddressSummary();
}

function renderWalletRow(wallet) {
  const expanded = state.expandedWalletIds.has(wallet.id);
  const statusClass = wallet.error ? "error" : wallet.hasEnoughGas ? "ok" : "warn";
  const statusText = wallet.error ? `错误: ${escapeHtml(wallet.error)}` : wallet.hasEnoughGas ? "可执行" : "Gas 偏低";
  const detailColspan = state.walletViewMode === "detail" ? 11 : 8;
  const detailRow = expanded
    ? `
      <tr class="wallet-detail-row">
        <td colspan="${detailColspan}">
          <div class="wallet-detail-card">
            <div class="wallet-detail-block">
              <strong>完整地址</strong>
              <code>${wallet.address}</code>
            </div>
            <div class="wallet-detail-block">
              <strong>Native 余额</strong>
              <div>${formatCell(wallet.nativeBalance)}</div>
            </div>
            <div class="wallet-detail-block">
              <strong>支付币余额</strong>
              <div>${formatCell(wallet.reserveBalance)}</div>
            </div>
            <div class="wallet-detail-block">
              <strong>目标币余额</strong>
              <div>${formatCell(wallet.tokenBalance)}</div>
            </div>
            <div class="wallet-detail-block">
              <strong>已抵押</strong>
              <div>${formatCell(wallet.collateralBalance)}</div>
            </div>
            <div class="wallet-detail-block">
              <strong>当前可借</strong>
              <div>${formatCell(wallet.borrowableAmount)}</div>
            </div>
            <div class="wallet-detail-block">
              <strong>当前需还</strong>
              <div>${formatCell(wallet.repayableAmount)}</div>
            </div>
          </div>
        </td>
      </tr>
    `
    : "";

  return `
    <tr class="wallet-row ${expanded ? "expanded" : ""} ${state.walletViewMode === "compact" ? "compact" : ""}" data-wallet-row="${wallet.id}">
      <td><input type="checkbox" data-wallet-select="${wallet.id}" ${state.selectedWalletIds.has(wallet.id) ? "checked" : ""} /></td>
      <td><button class="expand-button" data-wallet-expand="${wallet.id}" type="button">${expanded ? "-" : "+"}</button></td>
      <td>${wallet.index + 1}</td>
      <td>
        <div class="wallet-name">
          <strong>${wallet.shortAddress}</strong>
          <span class="wallet-subline">${wallet.enabled ? "已启用" : "已停用"}</span>
        </div>
      </td>
      <td><input class="mini-input" data-wallet-label="${wallet.id}" value="${escapeHtml(wallet.label || "")}" placeholder="标签" /></td>
      <td>${renderGroupBadges(wallet.groups)}</td>
      <td>
        <label class="toggle-wrap">
          <input type="checkbox" data-wallet-enabled="${wallet.id}" ${wallet.enabled ? "checked" : ""} />
          <span>${wallet.enabled ? "启用" : "停用"}</span>
        </label>
      </td>
      <td class="detail-only">${formatCell(wallet.nativeBalance)}</td>
      <td class="detail-only">${formatCell(wallet.reserveBalance)}</td>
      <td class="detail-only">${formatCell(wallet.tokenBalance)}</td>
      <td><span class="wallet-status ${statusClass}">${statusText}</span></td>
    </tr>
    ${detailRow}
  `;
}

function bindWalletRowEvents() {
  elements.walletTableBody.querySelectorAll("[data-wallet-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const walletId = checkbox.getAttribute("data-wallet-select");
      if (checkbox.checked) state.selectedWalletIds.add(walletId);
      else state.selectedWalletIds.delete(walletId);
      updateSelectionSummary();
    });
  });

  elements.walletTableBody.querySelectorAll("[data-wallet-expand]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleWalletExpand(button.getAttribute("data-wallet-expand"));
    });
  });

  elements.walletTableBody.querySelectorAll("[data-wallet-row]").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest("input") || event.target.closest("button") || event.target.closest("label")) return;
      toggleWalletExpand(row.getAttribute("data-wallet-row"));
    });
  });

  elements.walletTableBody.querySelectorAll("[data-wallet-enabled]").forEach((checkbox) => {
    checkbox.addEventListener("change", async () => {
      const id = checkbox.getAttribute("data-wallet-enabled");
      await api("/api/wallets/update", { method: "POST", body: JSON.stringify({ id, enabled: checkbox.checked }) });
      const wallet = state.wallets.find((item) => item.id === id);
      if (wallet) wallet.enabled = checkbox.checked;
      renderWallets();
      showToast("钱包状态已更新");
    });
  });

  elements.walletTableBody.querySelectorAll("[data-wallet-label]").forEach((input) => {
    input.addEventListener("change", async () => {
      const id = input.getAttribute("data-wallet-label");
      await api("/api/wallets/update", { method: "POST", body: JSON.stringify({ id, label: input.value.trim() }) });
      const wallet = state.wallets.find((item) => item.id === id);
      if (wallet) wallet.label = input.value.trim();
      showToast("标签已保存");
    });
  });
}

function toggleWalletExpand(walletId) {
  if (state.expandedWalletIds.has(walletId)) state.expandedWalletIds.delete(walletId);
  else state.expandedWalletIds.add(walletId);
  renderWallets();
}

function syncModeButtons() {
  elements.compactModeButton.classList.toggle("active", state.walletViewMode === "compact");
  elements.detailModeButton.classList.toggle("active", state.walletViewMode === "detail");
}

function renderGroupSelects() {
  elements.groupFilterSelect.innerHTML =
    ['<option value="">全部分组</option>']
      .concat(state.groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`))
      .join("");
  elements.groupAssignSelect.innerHTML =
    ['<option value="">选择分组</option>']
      .concat(state.groups.map((group) => `<option value="${escapeHtml(group)}">${escapeHtml(group)}</option>`))
      .join("");
}

function renderGroupBadges(groups) {
  if (!groups || groups.length === 0) return '<span class="inline-note">未分组</span>';
  return groups.map((group) => `<span class="group-badge">${escapeHtml(group)}</span>`).join("");
}

function updateSelectionSummary() {
  elements.selectionSummary.textContent = `已选 ${state.selectedWalletIds.size} 个钱包`;
  updateMarketAddressSummary();
}

function updateMarketAddressSummary() {
  const selectedCount = state.selectedWalletIds.size;
  const visibleCount = visibleWallets().length;
  const effectiveCount = selectedCount > 0 ? selectedCount : visibleCount;
  elements.marketAddressCount.textContent = String(effectiveCount);
  elements.marketAddressSummary.textContent =
    selectedCount > 0 ? `当前按已选钱包执行，共 ${selectedCount} 个地址` : `当前按筛选结果执行，共 ${visibleCount} 个地址`;
}

function selectAllVisibleWallets() {
  visibleWallets().forEach((wallet) => state.selectedWalletIds.add(wallet.id));
  renderWallets();
}

function clearSelection() {
  state.selectedWalletIds.clear();
  renderWallets();
}

function selectEnabledWallets() {
  state.selectedWalletIds.clear();
  visibleWallets().filter((wallet) => wallet.enabled).forEach((wallet) => state.selectedWalletIds.add(wallet.id));
  renderWallets();
}

async function importWallets() {
  const privateKeys = document.querySelector("#privateKeysInput").value.trim();
  if (!privateKeys) return showToast("先粘贴私钥", true);
  const response = await api("/api/wallets/import", { method: "POST", body: JSON.stringify({ privateKeys }) });
  document.querySelector("#privateKeysInput").value = "";
  showToast(`成功导入 ${response.imported} 个钱包`);
  await loadState();
  await refreshWallets();
}

async function importGenerated() {
  const path = document.querySelector("#walletFilePath").value.trim();
  const response = await api("/api/wallets/import-generated", { method: "POST", body: JSON.stringify({ path }) });
  showToast(`从文件导入 ${response.imported} 个钱包`);
  await loadState();
  await refreshWallets();
}

async function clearWallets() {
  await api("/api/wallets/clear", { method: "POST" });
  state.selectedWalletIds.clear();
  showToast("钱包池已清空");
  await loadState();
  await refreshWallets();
}

async function createGroup() {
  const name = document.querySelector("#newGroupName").value.trim();
  if (!name) return showToast("请输入分组名", true);
  await api("/api/groups", { method: "POST", body: JSON.stringify({ name }) });
  document.querySelector("#newGroupName").value = "";
  showToast("分组已创建");
  await loadState();
  await refreshWallets();
}

async function deleteGroup() {
  const name = elements.groupAssignSelect.value;
  if (!name) return showToast("先选择分组", true);
  await api("/api/groups/delete", { method: "POST", body: JSON.stringify({ name }) });
  showToast("分组已删除");
  await loadState();
  await refreshWallets();
}

async function assignGroups(mode) {
  const group = elements.groupAssignSelect.value;
  const walletIds = [...state.selectedWalletIds];
  if (walletIds.length === 0) return showToast("先选择钱包", true);
  if (!group && mode !== "replace") return showToast("先选择分组", true);
  await api("/api/groups/assign", {
    method: "POST",
    body: JSON.stringify({ walletIds, groupNames: group ? [group] : [], mode })
  });
  showToast("分组操作已完成");
  await loadState();
  await refreshWallets();
}

async function applyBulkLabel() {
  const walletIds = [...state.selectedWalletIds];
  const labelPrefix = document.querySelector("#bulkLabelPrefix").value.trim();
  const replaceExisting = document.querySelector("#bulkLabelReplaceExisting").checked;
  if (walletIds.length === 0) return showToast("先选择钱包", true);
  if (!labelPrefix) return showToast("请输入标签前缀", true);
  await api("/api/wallets/bulk-label", {
    method: "POST",
    body: JSON.stringify({ walletIds, labelPrefix, replaceExisting })
  });
  showToast("已批量更新标签");
  await refreshWallets();
}

function buildSelectionPayload() {
  const walletIds = [...state.selectedWalletIds];
  const groupName = elements.groupFilterSelect.value;
  return {
    walletIds,
    groupNames: walletIds.length === 0 && groupName ? [groupName] : [],
    includeDisabled: false
  };
}

function syncDerivedTaskInputs() {
  const minAmount = document.querySelector("#marketAmountMin").value.trim();
  const maxAmount = document.querySelector("#marketAmountMax").value.trim();
  const minInterval = Number(document.querySelector("#marketIntervalMin").value || "0");
  const maxInterval = Number(document.querySelector("#marketIntervalMax").value || "0");
  const effectiveAmount = minAmount || fromBaseUnits(document.querySelector("#buyAmount").value.trim(), state.assetMeta.reserveDecimals);
  const effectiveSellAmount = maxAmount || minAmount || fromBaseUnits(document.querySelector("#sellAmount").value.trim(), state.assetMeta.tokenDecimals);
  const effectiveConcurrency = Math.max(1, Number(document.querySelector("#defaultMaxConcurrency").value || "1"));
  const averageIntervalSec = [minInterval, maxInterval].filter((value) => value > 0).reduce((sum, value, _, arr) => sum + value / arr.length, 0);

  document.querySelector("#buyTaskAmount").value = toBaseUnits(effectiveAmount, state.assetMeta.reserveDecimals);
  document.querySelector("#sellTaskAmount").value = toBaseUnits(effectiveSellAmount, state.assetMeta.tokenDecimals);
  document.querySelector("#buyTaskConcurrency").value = String(Math.min(effectiveConcurrency, 20));
  document.querySelector("#sellTaskConcurrency").value = String(Math.min(effectiveConcurrency, 20));
  if (averageIntervalSec > 0) {
    document.querySelector("#randomTaskIntervalMs").value = String(Math.round(averageIntervalSec * 1000));
  }
}

function togglePanel(kind) {
  const isConfig = kind === "config";
  const panel = isConfig ? elements.configPanel : elements.riskPanel;
  const button = document.querySelector(isConfig ? "#toggleConfigPanelButton" : "#toggleRiskPanelButton");
  const collapsed = panel.classList.toggle("collapsed");
  button.textContent = collapsed ? (isConfig ? "展开配置" : "展开风控") : (isConfig ? "收起配置" : "收起风控");
}

function toggleOpsPanel(kind) {
  const panelMap = {
    import: elements.walletImportPanel,
    group: elements.walletGroupPanel,
    label: elements.walletLabelPanel
  };
  const buttonMap = {
    import: document.querySelector("#toggleWalletImportPanelButton"),
    group: document.querySelector("#toggleWalletGroupPanelButton"),
    label: document.querySelector("#toggleWalletLabelPanelButton")
  };
  const panel = panelMap[kind];
  const button = buttonMap[kind];
  const body = panel.querySelector(".ops-body");
  const expanded = panel.classList.toggle("expanded");
  body.classList.toggle("hidden", !expanded);
  button.textContent = expanded ? "收起" : "展开";
}

function syncMarketAmountLabels() {
  if (state.marketAction === "borrow") {
    elements.marketAmountHint.textContent = `借贷模式下：只填写抵押数量(${state.assetMeta.tokenSymbol})，系统自动按最大可借执行`;
    elements.marketAmountMinLabel.textContent = "抵押数量";
    elements.marketAmountMaxLabel.textContent = "自动最大可借";
    document.querySelector("#marketAmountMax").disabled = true;
    document.querySelector("#marketAmountMax").value = "";
    document.querySelector("#marketAmountMax").placeholder = `系统自动按最大可借(${state.assetMeta.reserveSymbol})`;
    elements.marketUnitHint.textContent = `这里填写页面显示单位，提交时会自动换算成链上最小单位。只需要填写 ${state.assetMeta.tokenSymbol} 抵押数量。`;
    return;
  }
  if (state.marketAction === "repay") {
    document.querySelector("#marketAmountMax").disabled = true;
    document.querySelector("#marketAmountMax").value = "";
    document.querySelector("#marketAmountMax").placeholder = `按需还金额与支付币余额自动截断(${state.assetMeta.reserveSymbol})`;
    elements.marketAmountHint.textContent = `偿还模式下：只填写目标偿还额，系统会自动按需还金额和支付币余额截断`;
    elements.marketAmountMinLabel.textContent = "目标偿还额";
    elements.marketAmountMaxLabel.textContent = "自动截断上限";
    elements.marketUnitHint.textContent = `偿还按 ${state.assetMeta.reserveSymbol} 页面显示单位填写，实际执行时会自动取 目标偿还额 / 当前需还 / 当前支付币余额 三者最小值。`;
    return;
  }
  document.querySelector("#marketAmountMax").disabled = false;
  document.querySelector("#marketAmountMax").placeholder = "";
  elements.marketAmountHint.textContent = `可设置金额范围，按页面显示单位填写`;
  elements.marketAmountMinLabel.textContent = "最小金额";
  elements.marketAmountMaxLabel.textContent = "最大金额";
  if (state.marketAction === "buy") {
    elements.marketUnitHint.textContent = `买入金额按 ${state.assetMeta.reserveSymbol} 的页面显示单位填写，比如填 3000，系统会自动换算成链上最小单位。`;
    return;
  }
  if (state.marketAction === "sell") {
    elements.marketUnitHint.textContent = `卖出数量按 ${state.assetMeta.tokenSymbol} 的页面显示单位填写，系统会自动换算成链上最小单位。`;
    return;
  }
}

function syncConfigUnitLabels() {
  elements.buyAmountLabel.textContent = `默认买入数量 (${state.assetMeta.reserveSymbol})`;
  elements.sellAmountLabel.textContent = `默认卖出数量 (${state.assetMeta.tokenSymbol})`;
  elements.randomReserveKeepAmountLabel.textContent = `随机支付币保留量 (${state.assetMeta.reserveSymbol})`;
  elements.randomTokenKeepAmountLabel.textContent = `随机目标币保留量 (${state.assetMeta.tokenSymbol})`;
  elements.randomMaxSellAmountLabel.textContent = `随机最大卖出量 (${state.assetMeta.tokenSymbol})`;
  elements.configUnitHint.textContent = `金额类配置按页面显示单位填写。${state.assetMeta.reserveSymbol}/${state.assetMeta.tokenSymbol} 会在保存时自动换算成链上最小单位。`;
}

function syncMarketActionTabs() {
  document.querySelectorAll("[data-market-action]").forEach((button) => {
    button.classList.toggle("active", button.getAttribute("data-market-action") === state.marketAction);
  });
  syncMarketAmountLabels();
}

function syncMarketActionHint() {
  const hintMap = {
    buy: "买入会使用“做市金额”的最小值作为当前下单金额。",
    sell: "卖出会优先使用“做市金额”的最大值作为当前下单金额。",
    borrow: "借贷会调用 depositAndBorrow：左侧抵押数量，右侧借贷数量。",
    repay: "偿还会优先使用“做市金额”的最大值作为偿还数量。"
  };
  elements.marketActionHint.textContent = hintMap[state.marketAction] || "";
}

async function runSelectedMarketAction() {
  syncDerivedTaskInputs();

  if (state.marketAction === "buy") {
    await runBatchBuy();
    return;
  }
  if (state.marketAction === "sell") {
    await runBatchSell();
    return;
  }
  if (state.marketAction === "borrow") {
    await runBatchBorrow();
    return;
  }
  if (state.marketAction === "repay") {
    await runBatchRepay();
  }
}

async function runBatchBuy() {
  const payload = {
    ...buildSelectionPayload(),
    amount: document.querySelector("#buyTaskAmount").value.trim(),
    amountMin: toBaseUnits(document.querySelector("#marketAmountMin").value.trim(), state.assetMeta.reserveDecimals),
    amountMax: toBaseUnits(document.querySelector("#marketAmountMax").value.trim(), state.assetMeta.reserveDecimals),
    intervalMinSec: Number(document.querySelector("#marketIntervalMin").value || "0"),
    intervalMaxSec: Number(document.querySelector("#marketIntervalMax").value || "0"),
    timeStart: document.querySelector("#marketTimeStart").value,
    timeEnd: document.querySelector("#marketTimeEnd").value,
    maxConcurrency: Number(document.querySelector("#buyTaskConcurrency").value || "1")
  };
  await confirmTaskRun("批量买入", payload, async () => {
    const response = await api("/api/tasks/buy", { method: "POST", body: JSON.stringify(payload) });
    state.selectedJobId = response.jobId;
    showToast("批量买入任务已启动");
    await refreshJobs();
  });
}

async function runBatchSell() {
  const payload = {
    ...buildSelectionPayload(),
    amount: document.querySelector("#sellTaskAmount").value.trim(),
    amountMin: toBaseUnits(document.querySelector("#marketAmountMin").value.trim(), state.assetMeta.tokenDecimals),
    amountMax: toBaseUnits(document.querySelector("#marketAmountMax").value.trim(), state.assetMeta.tokenDecimals),
    intervalMinSec: Number(document.querySelector("#marketIntervalMin").value || "0"),
    intervalMaxSec: Number(document.querySelector("#marketIntervalMax").value || "0"),
    timeStart: document.querySelector("#marketTimeStart").value,
    timeEnd: document.querySelector("#marketTimeEnd").value,
    maxConcurrency: Number(document.querySelector("#sellTaskConcurrency").value || "1")
  };
  await confirmTaskRun("批量卖出", payload, async () => {
    const response = await api("/api/tasks/sell", { method: "POST", body: JSON.stringify(payload) });
    state.selectedJobId = response.jobId;
    showToast("批量卖出任务已启动");
    await refreshJobs();
  });
}

async function runBatchBorrow() {
  const payload = {
    ...buildSelectionPayload(),
    depositAmount: toBaseUnits(document.querySelector("#marketAmountMin").value.trim(), state.assetMeta.tokenDecimals),
    intervalMinSec: Number(document.querySelector("#marketIntervalMin").value || "0"),
    intervalMaxSec: Number(document.querySelector("#marketIntervalMax").value || "0"),
    timeStart: document.querySelector("#marketTimeStart").value,
    timeEnd: document.querySelector("#marketTimeEnd").value,
    maxConcurrency: Number(document.querySelector("#buyTaskConcurrency").value || "1")
  };
  await confirmTaskRun("批量借贷", payload, async () => {
    const response = await api("/api/tasks/borrow", { method: "POST", body: JSON.stringify(payload) });
    state.selectedJobId = response.jobId;
    showToast("批量借贷任务已启动");
    await refreshJobs();
  });
}

async function runBatchRepay() {
  const payload = {
    ...buildSelectionPayload(),
    amount: toBaseUnits(document.querySelector("#marketAmountMin").value.trim(), state.assetMeta.reserveDecimals),
    amountMin: toBaseUnits(document.querySelector("#marketAmountMin").value.trim(), state.assetMeta.reserveDecimals),
    amountMax: toBaseUnits(document.querySelector("#marketAmountMax").value.trim(), state.assetMeta.reserveDecimals),
    intervalMinSec: Number(document.querySelector("#marketIntervalMin").value || "0"),
    intervalMaxSec: Number(document.querySelector("#marketIntervalMax").value || "0"),
    timeStart: document.querySelector("#marketTimeStart").value,
    timeEnd: document.querySelector("#marketTimeEnd").value,
    maxConcurrency: Number(document.querySelector("#sellTaskConcurrency").value || "1")
  };
  await confirmTaskRun("批量偿还", payload, async () => {
    const response = await api("/api/tasks/repay", { method: "POST", body: JSON.stringify(payload) });
    state.selectedJobId = response.jobId;
    showToast("批量偿还任务已启动");
    await refreshJobs();
  });
}

async function runRandomTask() {
  const payload = {
    ...buildSelectionPayload(),
    rounds: Number(document.querySelector("#randomTaskRounds").value || "1"),
    intervalMs: Number(document.querySelector("#randomTaskIntervalMs").value || "60000"),
    walletsPerRound: Number(document.querySelector("#randomTaskWalletsPerRound").value || "1"),
    maxConcurrency: Number(document.querySelector("#randomTaskMaxConcurrency").value || "1"),
    buyProbabilityBps: Number(document.querySelector("#randomTaskBuyProbabilityBps").value || "5000"),
    buyAmount: document.querySelector("#randomTaskBuyAmount").value.trim(),
    reserveKeepAmount: document.querySelector("#randomTaskReserveKeepAmount").value.trim(),
    tokenKeepAmount: document.querySelector("#randomTaskTokenKeepAmount").value.trim(),
    maxSellAmount: document.querySelector("#randomTaskMaxSellAmount").value.trim(),
    sellDivisor: Number(document.querySelector("#randomTaskSellDivisor").value || "5")
  };
  await confirmTaskRun("随机做市", payload, async () => {
    const response = await api("/api/tasks/random", { method: "POST", body: JSON.stringify(payload) });
    state.selectedJobId = response.jobId;
    showToast("随机做市任务已启动");
    await refreshJobs();
  });
}

async function confirmTaskRun(title, payload, onConfirm) {
  const selectedWallets = resolveSelectedWalletsForSummary(payload);
  const risk = currentRiskValues();
  const selectedGroups =
    payload.groupNames && payload.groupNames.length > 0 ? payload.groupNames.join(", ") : "未按组";
  const rpcUrl = document.querySelector("#rpcUrl").value.trim();
  const chainWarning = buildChainWarning(rpcUrl);
  const beijingWindow = `${document.querySelector("#marketTimeStart").value || "--:--"} - ${document.querySelector("#marketTimeEnd").value || "--:--"}`;

  elements.confirmModalContent.innerHTML = `
    ${chainWarning.html}
    <div class="confirm-grid">
      <div class="confirm-block"><strong>任务类型</strong><div>${escapeHtml(title)}</div></div>
      <div class="confirm-block"><strong>命中钱包数</strong><div>${selectedWallets.length}</div></div>
      <div class="confirm-block"><strong>已选分组</strong><div>${escapeHtml(selectedGroups)}</div></div>
      <div class="confirm-block"><strong>北京时间段</strong><div>${escapeHtml(beijingWindow)}</div></div>
      <div class="confirm-block"><strong>目标买卖合约</strong><div>${escapeHtml(document.querySelector("#marketContractAddress").value.trim())}</div></div>
      <div class="confirm-block"><strong>目标币合约</strong><div>${escapeHtml(document.querySelector("#tokenAddress").value.trim())}</div></div>
      <div class="confirm-block"><strong>支付币合约</strong><div>${escapeHtml(document.querySelector("#reserveTokenAddress").value.trim())}</div></div>
      <div class="confirm-block"><strong>标签样例</strong><div>${escapeHtml(selectedWallets.slice(0, 5).map((wallet) => wallet.label || wallet.shortAddress).join(" / ") || "未选择")}</div></div>
      <div class="confirm-block"><strong>任务参数</strong><div>${escapeHtml(JSON.stringify(payload))}</div></div>
      <div class="confirm-block"><strong>关键风控</strong><div>${escapeHtml(JSON.stringify(risk))}</div></div>
    </div>
  `;

  const confirmButton = document.querySelector("#confirmSubmitButton");
  confirmButton.textContent = chainWarning.isBlocked ? "测试网未确认，暂不执行" : "确认执行";
  confirmButton.disabled = chainWarning.isBlocked;

  pendingConfirmAction = chainWarning.isBlocked ? null : onConfirm;
  openConfirmModal();

  if (chainWarning.isBlocked) {
    const checkbox = document.querySelector("#testnetOverrideCheckbox");
    if (checkbox) {
      checkbox.addEventListener("change", () => {
        const allowed = checkbox.checked;
        confirmButton.disabled = !allowed;
        confirmButton.textContent = allowed ? "确认在测试网执行" : "测试网未确认，暂不执行";
        pendingConfirmAction = allowed ? onConfirm : null;
      });
    }
  }
}

function buildChainWarning(rpcUrl) {
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("sepolia")) {
    return {
      isBlocked: true,
      html: `
        <div class="chain-warning">
          <strong>高风险警告: 当前 RPC 仍是 Sepolia 测试网</strong>
          <div>如果继续执行，交易会发到测试网，不会出现在 growchain.cc 当前主网页面。</div>
          <div>如果你现在就是要做测试网联调，请手动勾选下方确认。</div>
          <label class="testnet-override">
            <input id="testnetOverrideCheckbox" type="checkbox" />
            <span>我确认这是 Sepolia 测试网测试，允许继续执行</span>
          </label>
        </div>
      `
    };
  }

  return {
    isBlocked: false,
    html: `
      <div class="chain-info">
        <strong>链路检查</strong>
        <div>当前 RPC 未命中 Sepolia 关键词，请继续核对是否为 growchain.cc 实际使用的目标链 RPC。</div>
      </div>
    `
  };
}

function resolveSelectedWalletsForSummary(payload) {
  let wallets = [...state.wallets];
  if (payload.walletIds && payload.walletIds.length > 0) {
    const idSet = new Set(payload.walletIds);
    wallets = wallets.filter((wallet) => idSet.has(wallet.id));
  } else if (payload.groupNames && payload.groupNames.length > 0) {
    wallets = wallets.filter((wallet) => wallet.groups.some((group) => payload.groupNames.includes(group)));
  } else {
    wallets = wallets.filter((wallet) => wallet.enabled);
  }
  return wallets;
}

function currentRiskValues() {
  const result = {};
  Object.entries(riskFieldMap).forEach(([inputId, riskKey]) => {
    result[riskKey] = document.querySelector(`#${inputId}`).value.trim();
  });
  return result;
}

function openConfirmModal() {
  elements.confirmModal.classList.remove("hidden");
}

function closeConfirmModal() {
  elements.confirmModal.classList.add("hidden");
  const confirmButton = document.querySelector("#confirmSubmitButton");
  confirmButton.disabled = false;
  confirmButton.textContent = "确认执行";
}

async function refreshJobs() {
  const response = await api("/api/jobs");
  state.jobs = response.jobs || [];
  state.activeJobId = response.activeJobId || null;
  elements.activeJob.textContent = state.activeJobId ? state.activeJobId.slice(0, 8) : "无";
  if (!state.selectedJobId && state.jobs.length > 0) state.selectedJobId = state.jobs[0].id;
  renderJobs();
  if (state.selectedJobId) await loadJobDetail(state.selectedJobId);
}

function renderJobs() {
  elements.jobsList.innerHTML = state.jobs
    .map(
      (job) => {
        const total = Math.max(1, Number(job.summary.total || 0));
        const confirmed = Number(job.summary.confirmed || 0);
        const percent = Math.min(100, Math.round((confirmed / total) * 100));
        return `
        <button class="job-item ${job.id === state.selectedJobId ? "active" : ""}" data-job-id="${job.id}">
          <div class="job-item-top">
            <strong>${job.kind}</strong>
            <span class="job-status-chip ${escapeHtml(String(job.status || "").toLowerCase())}">${job.status}</span>
          </div>
          <div class="job-progress">
            <div class="job-progress-bar">
              <div class="job-progress-fill" style="width: ${percent}%"></div>
            </div>
            <span class="job-progress-value">${confirmed}/${total}</span>
          </div>
          <div class="job-meta">
            <span>${percent}% 完成</span>
            <span>${job.summary.failed || 0} 失败</span>
          </div>
        </button>
      `;
      }
    )
    .join("");

  elements.jobsList.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedJobId = button.getAttribute("data-job-id");
      renderJobs();
      await loadJobDetail(state.selectedJobId);
    });
  });
}

async function loadJobDetail(jobId) {
  const job = await api(`/api/jobs/${jobId}`);
  const total = Number(job.summary.total || 0);
  const confirmed = Number(job.summary.confirmed || 0);
  const failed = Number(job.summary.failed || 0);
  const skipped = Number(job.summary.skipped || 0);
  const cancelled = Number(job.summary.cancelled || 0);
  const paramsText = JSON.stringify(job.params || {}, null, 2);
  elements.jobSummary.innerHTML = `
    <div class="job-kv-card">
      <dl class="job-kv-list">
        <div><dt>任务类型</dt><dd>${escapeHtml(job.kind)}</dd></div>
        <div><dt>状态</dt><dd>${escapeHtml(job.status)}</dd></div>
        <div><dt>确认数</dt><dd>${confirmed}/${Math.max(1, total)}</dd></div>
        <div><dt>失败数</dt><dd>${failed}</dd></div>
        <div><dt>跳过数</dt><dd>${skipped}</dd></div>
        <div><dt>取消数</dt><dd>${cancelled}</dd></div>
        <div><dt>创建时间</dt><dd>${escapeHtml(job.createdAt)}</dd></div>
      </dl>
      <div class="job-params-block">
        <strong>选择参数</strong>
        <pre class="job-params-pre">${escapeHtml(paramsText)}</pre>
      </div>
      ${job.error ? `<div class="job-error"><strong>错误</strong><span>${escapeHtml(job.error)}</span></div>` : ""}
    </div>
  `;
  elements.jobLogs.textContent = (job.logs || []).join("\n") || "暂无日志";
  elements.jobLogMeta.textContent = `${confirmed}/${Math.max(1, total)} 已确认`;
  elements.jobLogs.scrollTop = elements.jobLogs.scrollHeight;
}

async function cancelActiveJob() {
  if (!state.activeJobId) return showToast("当前没有运行中的任务", true);
  await api(`/api/jobs/${state.activeJobId}/cancel`, { method: "POST" });
  showToast("已发送停止请求");
  await refreshJobs();
}

function formatCell(value) {
  if (value === undefined || value === null || value === "") return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
  return data;
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  elements.toast.style.background = isError ? "rgba(143, 34, 24, 0.94)" : "rgba(28, 36, 29, 0.92)";
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.add("hidden");
  }, 2600);
}

function toBaseUnits(value, decimals) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d+(\.\d+)?$/.test(text)) return text;
  const [wholePart, fractionPart = ""] = text.split(".");
  const paddedFraction = (fractionPart + "0".repeat(decimals)).slice(0, decimals);
  const normalized = `${wholePart}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return normalized || "0";
}

function fromBaseUnits(value, decimals) {
  const text = String(value || "").trim();
  if (!/^\d+$/.test(text)) return text;
  const normalized = text.padStart(decimals + 1, "0");
  const whole = normalized.slice(0, -decimals) || "0";
  const fraction = normalized.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

import { deleteLocal, readLocal, writeLocal } from "./db.js";
import { DiscordApi, DiscordApiError } from "./discord-api.js";

const state = {
  api: null, currentUser: null, all: [], filtered: [], page: 1, pageSize: 100,
  pendingRemoveId: null, removingId: null, scanRunning: false, scanPaused: false,
  scanError: null, workspace: "friends", operations: [], operationFilter: "all",
  pendingReaddId: null,
};

const TYPE_LABELS = {
  friend: "好友", blocked: "封鎖", incoming_request: "收到的邀請",
  outgoing_request: "送出的邀請", implicit: "其他", suggestion: "建議", unknown: "未知",
};
const RELATIONSHIP_TYPES = { 1: "friend", 2: "blocked", 3: "incoming_request", 4: "outgoing_request", 5: "implicit", 6: "suggestion" };
const FLAG_LABELS = [
  [1, "Discord 員工"], [2, "合作夥伴"], [4, "HypeSquad 活動"], [8, "Bug Hunter I"],
  [64, "Bravery"], [128, "Brilliance"], [256, "Balance"], [512, "早期支持者"],
  [16384, "Bug Hunter II"], [131072, "早期機器人開發者"], [262144, "認證版主"], [4194304, "Active Developer"],
];
const OPERATION_LABELS = { remove_friend: "移除好友", send_friend_request: "送出好友邀請" };
const OPERATION_STATUS_LABELS = { pending: "處理中", completed: "已完成", failed: "失敗" };
const $ = (selector) => document.querySelector(selector);
const now = () => new Date().toISOString();

function logDiagnostic(entry) {
  console.info("[Discord Friend Manager]", { ...entry });
}

async function runPublicProbe() {
  logDiagnostic({
    time: now(), event: "public_probe", path: "/gateway", origin: location.origin,
    online: navigator.onLine, user_agent: navigator.userAgent,
  });
  try {
    const response = await fetch("https://discord.com/api/v10/gateway", {
      mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
    });
    logDiagnostic({
      time: now(), event: "public_probe_response", path: "/gateway",
      status: response.status, response_type: response.type,
    });
  } catch (error) {
    logDiagnostic({
      time: now(), event: "public_probe_error", path: "/gateway",
      error_name: error?.name || "Error", error_message: error?.message || String(error),
    });
  }
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function snowflakeDate(value) {
  try {
    return new Date(Number((BigInt(value) >> 22n) + 1420070400000n)).toISOString();
  } catch {
    return null;
  }
}

function avatarUrl(user) {
  if (!user?.id || !user?.avatar) return null;
  const extension = user.avatar.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${extension}?size=64`;
}

function normaliseRelationship(raw, previous = null) {
  const user = raw.user || {};
  const id = String(user.id || raw.id || "");
  const type = Number(raw.type || 0);
  const username = String(user.username || "");
  const globalName = user.global_name || null;
  const nickname = raw.nickname || null;
  return {
    id, type, type_name: RELATIONSHIP_TYPES[type] || "unknown", username, global_name: globalName,
    display_name: nickname || globalName || username || id, nickname, note: raw.note || null,
    since: raw.since || null, account_created_at: snowflakeDate(id),
    last_message_at: previous?.last_message_at || null,
    last_message_checked: Boolean(previous?.last_message_checked), avatar_url: avatarUrl(user),
    public_flags: Number(user.public_flags || 0), guild_tag: user?.primary_guild?.tag || user?.clan?.tag || null,
    is_spam_request: Boolean(raw.is_spam_request), user_ignored: Boolean(raw.user_ignored),
  };
}

function relationshipSnapshot(item) {
  return {
    id: item.id, username: item.username, global_name: item.global_name,
    display_name: item.display_name, avatar_url: item.avatar_url, public_flags: item.public_flags,
  };
}

function applyRecentChannels(items, channels) {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const channel of channels || []) {
    const lastMessageAt = snowflakeDate(channel.last_message_id);
    for (const recipient of channel.recipients || []) {
      const relationship = byId.get(String(recipient.id));
      if (relationship && lastMessageAt) relationship.last_message_at = lastMessageAt;
    }
  }
}

function flagNames(value) {
  const labels = FLAG_LABELS.filter(([bit]) => (value & bit) === bit).map(([, label]) => label);
  return labels.length ? labels.join("、") : "—";
}

function initials(item) {
  return Array.from(item.display_name || item.username || "?").slice(0, 2).join("").toUpperCase();
}

function compareValues(left, right, direction) {
  const missingLeft = left === null || left === undefined || left === "";
  const missingRight = right === null || right === undefined || right === "";
  if (missingLeft && missingRight) return 0;
  if (missingLeft) return 1;
  if (missingRight) return -1;
  const result = typeof left === "number" ? left - right : String(left).localeCompare(String(right), "zh-Hant", { numeric: true, sensitivity: "base" });
  return direction === "asc" ? result : -result;
}

function applyFilters() {
  const query = $("#searchInput").value.trim().toLocaleLowerCase("zh-Hant");
  const type = $("#typeFilter").value;
  const field = $("#sortField").value;
  const direction = $("#sortDirection").value;
  state.pageSize = Number($("#pageSize").value);
  state.filtered = state.all.filter((item) => {
    if (type !== "all" && item.type_name !== type) return false;
    if (!query) return true;
    return [item.display_name, item.username, item.id, item.note, item.nickname, item.guild_tag]
      .filter(Boolean).join(" ").toLocaleLowerCase("zh-Hant").includes(query);
  }).sort((a, b) => compareValues(a[field], b[field], direction));
  state.page = Math.min(state.page, Math.max(1, Math.ceil(state.filtered.length / state.pageSize)));
  renderRows();
}

function renderRows() {
  const start = (state.page - 1) * state.pageSize;
  const visible = state.filtered.slice(start, start + state.pageSize);
  const body = $("#relationshipRows");
  body.innerHTML = visible.length ? visible.map((item) => `
    <article class="friend-row" data-id="${escapeHtml(item.id)}">
      <div class="user">
        <div class="avatar-wrap" aria-hidden="true"><div class="avatar-fallback">${escapeHtml(initials(item))}</div>${item.avatar_url ? `<img class="avatar" src="${escapeHtml(item.avatar_url)}" alt="" loading="lazy">` : ""}</div>
        <div><div class="user-name" title="${escapeHtml(item.display_name)}">${escapeHtml(item.display_name)}</div><div class="user-handle" title="${escapeHtml(item.id)}">@${escapeHtml(item.username)} · ${escapeHtml(item.id)}</div></div>
      </div>
      <div class="cell relation-cell"><span class="relation ${escapeHtml(item.type_name)}">${escapeHtml(TYPE_LABELS[item.type_name] || "未知")}</span></div>
      <div class="cell since-cell">${escapeHtml(formatDate(item.since))}</div>
      <div class="cell created-cell">${escapeHtml(formatDate(item.account_created_at))}</div>
      <div class="cell last-message-cell">${escapeHtml(formatDate(item.last_message_at))}</div>
      <div class="row-actions">${item.type_name === "friend" ? `<button class="remove-friend" type="button" data-remove-id="${escapeHtml(item.id)}" title="按住 Shift 可跳過確認">移除好友</button>` : `<span class="cell flags" title="${escapeHtml(flagNames(item.public_flags))}">${escapeHtml(item.guild_tag || flagNames(item.public_flags))}</span>`}</div>
    </article>`).join("") : '<div class="empty">沒有符合條件的資料</div>';
  body.querySelectorAll(".avatar").forEach((image) => image.addEventListener("error", () => image.remove()));
  const pageCount = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  $("#resultCount").textContent = `${state.filtered.length.toLocaleString("zh-TW")} 筆結果`;
  $("#pageStatus").textContent = `第 ${state.page} / ${pageCount} 頁`;
  $("#previousPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= pageCount;
}

function renderSummary(source = "cache", fetchedAt = null) {
  $("#totalCount").textContent = state.all.length.toLocaleString("zh-TW");
  $("#friendCount").textContent = state.all.filter((item) => item.type_name === "friend").length.toLocaleString("zh-TW");
  $("#outgoingCount").textContent = state.all.filter((item) => item.type_name === "outgoing_request").length.toLocaleString("zh-TW");
  $("#notedCount").textContent = state.all.filter((item) => item.note).length.toLocaleString("zh-TW");
  $("#sourceBadge").textContent = source === "discord" ? "剛從 Discord 取得" : "瀏覽器快取";
  $("#fetchedAt").textContent = fetchedAt ? `擷取於 ${formatDate(fetchedAt)}` : "尚無快取";
}

function updateConnection() {
  $("#sessionUser").textContent = state.currentUser ? `已連線：${state.currentUser.global_name || state.currentUser.username}` : "Token 未載入";
  $("#refreshButton").disabled = !state.api;
  $("#logoutButton").disabled = !state.api;
}

function switchWorkspace(workspace) {
  state.workspace = workspace;
  const isFriends = workspace === "friends";
  $("#friendsView").hidden = !isFriends;
  $("#operationsView").hidden = isFriends;
  $("#friendsSidebar").hidden = !isFriends;
  $("#sidebarFilters").hidden = !isFriends;
  $("#operationsSidebar").hidden = isFriends;
  $("#sidebarScan").hidden = !isFriends;
  $(".header-search").hidden = !isFriends;
  $("#friendsWorkspaceButton").classList.toggle("active", isFriends);
  $("#operationsWorkspaceButton").classList.toggle("active", !isFriends);
  $("#sidebarTitle").textContent = isFriends ? "好友管理" : "操作紀錄";
  $("#workspaceIcon").textContent = isFriends ? "♟" : "≡";
  $("#workspaceTitle").textContent = isFriends ? "好友" : "操作紀錄";
  $("#workspaceSubtitle").textContent = isFriends ? "排序與整理" : "刪除與好友邀請歷程";
  if (!isFriends) renderOperations();
}

function renderOperations() {
  const query = $("#operationSearch").value.trim().toLocaleLowerCase("zh-Hant");
  const visible = state.operations.filter((operation) => {
    if (state.operationFilter !== "all" && operation.action !== state.operationFilter) return false;
    const user = operation.user || {};
    return !query || [user.display_name, user.global_name, user.username, user.id].filter(Boolean).join(" ").toLocaleLowerCase("zh-Hant").includes(query);
  });
  $("#operationCount").textContent = visible.length.toLocaleString("zh-TW");
  const rows = $("#operationRows");
  if (!visible.length) return void (rows.innerHTML = '<div class="empty">沒有符合條件的操作紀錄</div>');
  rows.innerHTML = visible.map((operation) => {
    const user = operation.user || {};
    const canReadd = operation.action === "remove_friend" && operation.status === "completed" && !operation.readd_requested_at;
    return `<article class="operation-row" data-operation-id="${escapeHtml(operation.id)}">
      <div class="user"><div class="avatar-wrap" aria-hidden="true"><div class="avatar-fallback">${escapeHtml(initials(user))}</div>${user.avatar_url ? `<img class="avatar" src="${escapeHtml(user.avatar_url)}" alt="" loading="lazy">` : ""}</div><div><div class="user-name">${escapeHtml(user.display_name || user.id)}</div><div class="user-handle">${user.username ? `@${escapeHtml(user.username)} · ` : ""}${escapeHtml(user.id)}</div></div></div>
      <div class="operation-action">${escapeHtml(OPERATION_LABELS[operation.action] || operation.action)}<div class="operation-source">${escapeHtml(operation.error || "僅保存於此瀏覽器")}</div></div>
      <div class="operation-state"><span class="operation-status ${escapeHtml(operation.status)}">${escapeHtml(OPERATION_STATUS_LABELS[operation.status] || operation.status)}</span></div>
      <div class="operation-time cell">${escapeHtml(formatDate(operation.occurred_at))}</div>
      <div class="row-actions">${canReadd ? `<button class="readd-friend" type="button" data-readd-id="${escapeHtml(operation.id)}">重新加好友</button>` : `<span class="subtle">${operation.readd_requested_at ? "已送出邀請" : "—"}</span>`}</div>
    </article>`;
  }).join("");
  rows.querySelectorAll(".avatar").forEach((image) => image.addEventListener("error", () => image.remove()));
}

async function persistRelationships(source = "cache") {
  const fetchedAt = now();
  await writeLocal("relationships", { version: 1, fetched_at: fetchedAt, relationships: state.all });
  renderSummary(source, fetchedAt);
}

async function persistOperations() {
  await writeLocal("operations", state.operations);
  renderOperations();
}

function getScanStatus() {
  const friends = state.all.filter((item) => item.type_name === "friend");
  const completed = friends.filter((item) => item.last_message_checked).length;
  const withTime = friends.filter((item) => item.last_message_at).length;
  return {
    status: state.scanRunning ? (state.scanPaused ? "pausing" : "scanning") : (completed === friends.length && friends.length ? "complete" : (state.scanError ? "error" : "idle")),
    total: friends.length, completed, remaining: friends.length - completed, with_time: withTime, error: state.scanError,
  };
}

function renderScanStatus() {
  const scan = getScanStatus();
  const labels = { idle: "尚未完成", scanning: "掃描中", pausing: "正在暫停", complete: "已完成", error: "發生錯誤" };
  $("#scanProgress").max = Math.max(scan.total, 1);
  $("#scanProgress").value = scan.completed;
  $("#scanStatus").textContent = labels[scan.status] || scan.status;
  $("#scanStatus").className = `scan-status ${scan.status}`;
  $("#scanCounts").textContent = `已檢查 ${scan.completed.toLocaleString("zh-TW")} / ${scan.total.toLocaleString("zh-TW")} · 有時間 ${scan.with_time.toLocaleString("zh-TW")} · 剩餘 ${scan.remaining.toLocaleString("zh-TW")}`;
  $("#scanSummary").textContent = scan.error || (scan.status === "complete" ? "所有好友均已檢查，結果只保存在此瀏覽器。" : (scan.status === "scanning" || scan.status === "pausing" ? "正在逐位取得 DM 最後訊息時間，限流時會自動等待。" : "Discord 最近 DM 不完整，可從目前進度接續補查。"));
  $("#startScanButton").hidden = state.scanRunning || scan.status === "complete";
  $("#startScanButton").textContent = scan.completed ? "繼續補齊" : "補齊時間";
  $("#pauseScanButton").hidden = !state.scanRunning;
  $("#pauseScanButton").disabled = state.scanPaused;
}

async function refreshRelationships() {
  if (!state.api) return showTokenDialog();
  $("#refreshButton").disabled = true;
  try {
    const previous = new Map(state.all.map((item) => [item.id, item]));
    const [raw, channels] = await Promise.all([state.api.relationships(), state.api.privateChannels()]);
    state.all = raw.map((item) => normaliseRelationship(item, previous.get(String(item.user?.id || item.id))));
    applyRecentChannels(state.all, channels);
    await persistRelationships("discord");
    state.page = 1;
    applyFilters();
    renderScanStatus();
    showToast(`已從 Discord 更新 ${state.all.length.toLocaleString("zh-TW")} 筆關係`);
  } catch (error) {
    showToast(error.message);
  } finally {
    $("#refreshButton").disabled = false;
  }
}

async function startMessageScan() {
  if (!state.api) return showTokenDialog();
  if (state.scanRunning) return;
  state.scanRunning = true;
  state.scanPaused = false;
  state.scanError = null;
  renderScanStatus();
  try {
    for (const item of state.all.filter((entry) => entry.type_name === "friend" && !entry.last_message_checked)) {
      if (state.scanPaused) break;
      try {
        const channel = await state.api.startPrivateMessage(item.id);
        item.last_message_at = snowflakeDate(channel.last_message_id);
        item.last_message_checked = true;
        await persistRelationships();
        renderRows();
        renderScanStatus();
      } catch (error) {
        if (error instanceof DiscordApiError && [400, 403, 404].includes(error.status)) {
          item.last_message_at = null;
          item.last_message_checked = true;
          await persistRelationships();
          renderScanStatus();
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    state.scanError = error.message;
  } finally {
    state.scanRunning = false;
    state.scanPaused = false;
    renderScanStatus();
  }
}

function pauseMessageScan() {
  state.scanPaused = true;
  renderScanStatus();
}

function newOperation(action, item, relationship = null, linkedOperationId = null) {
  const createdAt = now();
  return {
    id: crypto.randomUUID(), action, status: "pending", source: "browser_action",
    created_at: createdAt, occurred_at: createdAt, completed_at: null, failed_at: null,
    error: null, linked_operation_id: linkedOperationId, user: relationshipSnapshot(item), relationship,
  };
}

async function removeFriend(userId) {
  if (!state.api) return showTokenDialog();
  if (state.removingId) return showToast("請等待目前的移除操作完成。");
  const item = state.all.find((entry) => entry.id === userId);
  if (!item || item.type_name !== "friend") return;
  state.removingId = userId;
  const operation = newOperation("remove_friend", item, { ...item });
  state.operations.unshift(operation);
  await persistOperations();
  const button = document.querySelector(`[data-remove-id="${CSS.escape(userId)}"]`);
  if (button) { button.disabled = true; button.textContent = "移除中…"; }
  try {
    await state.api.removeFriend(userId);
    operation.status = "completed";
    operation.completed_at = now();
    state.all = state.all.filter((entry) => entry.id !== userId);
    await Promise.all([persistOperations(), persistRelationships()]);
    applyFilters();
    renderScanStatus();
    showToast(`已移除 ${item.display_name}`);
  } catch (error) {
    operation.status = "failed";
    operation.failed_at = now();
    operation.error = error.message;
    await persistOperations();
    showToast(error.message);
    if (button) { button.disabled = false; button.textContent = "移除好友"; }
  } finally {
    state.removingId = null;
  }
}

async function readdFriend(operationId) {
  if (!state.api) return showTokenDialog();
  const removal = state.operations.find((item) => item.id === operationId);
  if (!removal) return;
  const operation = newOperation("send_friend_request", removal.user, null, removal.id);
  state.operations.unshift(operation);
  await persistOperations();
  try {
    await state.api.sendFriendRequest(removal.user.id);
    const completedAt = now();
    operation.status = "completed";
    operation.completed_at = completedAt;
    removal.readd_requested_at = completedAt;
    state.all.push({ ...(removal.relationship || {}), ...removal.user, type: 4, type_name: "outgoing_request", since: null, nickname: null, note: null });
    await Promise.all([persistOperations(), persistRelationships()]);
    applyFilters();
    showToast(`已向 ${removal.user.display_name || removal.user.id} 送出好友邀請`);
  } catch (error) {
    operation.status = "failed";
    operation.failed_at = now();
    operation.error = error.message;
    await persistOperations();
    showToast(error.message);
  }
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function exportCsv() {
  const headers = ["ID", "顯示名稱", "使用者名稱", "關係", "成為好友時間", "帳號建立時間", "最後訊息時間", "自訂暱稱", "備註", "Guild Tag", "公開旗標"];
  const rows = state.filtered.map((item) => [item.id, item.display_name, item.username, TYPE_LABELS[item.type_name] || item.type_name, item.since, item.account_created_at, item.last_message_at, item.nickname, item.note, item.guild_tag, flagNames(item.public_flags)]);
  const csv = "\ufeff" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.download = `discord-relationships-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

let toastTimer;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 5000);
}

async function clearCache() {
  await deleteLocal("relationships");
  $("#sourceBadge").textContent = "快取已清除";
  $("#fetchedAt").textContent = "目前畫面仍保留";
  showToast("好友快取已清除；操作紀錄仍保留。重新載入後需再從 Discord 取得資料。");
}

function showTokenDialog() {
  $("#tokenError").hidden = true;
  if (!$("#tokenDialog").open) $("#tokenDialog").showModal();
  $("#tokenInput").focus();
}

function forgetToken() {
  state.scanPaused = true;
  state.api?.clearToken();
  state.api = null;
  state.currentUser = null;
  $("#tokenInput").value = "";
  updateConnection();
}

async function connect(event) {
  event.preventDefault();
  const tokenInput = $("#tokenInput");
  const errorNode = $("#tokenError");
  const button = $("#connectButton");
  const token = tokenInput.value.trim();
  if (!token) return;
  tokenInput.value = "";
  state.api = new DiscordApi(token, fetch, logDiagnostic);
  button.disabled = true;
  button.textContent = "連線中…";
  errorNode.hidden = true;
  try {
    state.currentUser = await state.api.currentUser();
    updateConnection();
    $("#tokenDialog").close();
    if (!state.all.length) await refreshRelationships();
    showToast("Token 僅保存在此分頁記憶體，關閉或重新整理後會忘記。");
  } catch (error) {
    await runPublicProbe();
    forgetToken();
    errorNode.textContent = error.status === 401 ? "Token 無效或已失效。" : error.message;
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "連線";
  }
}

function selectNavigation(type, button) {
  $("#typeFilter").value = type;
  $("#friendsSidebar").querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.page = 1;
  applyFilters();
}

async function initialise() {
  try {
    const [cached, operations] = await Promise.all([readLocal("relationships"), readLocal("operations", [])]);
    state.operations = Array.isArray(operations) ? operations : [];
    if (cached?.version === 1 && Array.isArray(cached.relationships)) {
      state.all = cached.relationships;
      renderSummary("cache", cached.fetched_at);
    } else renderSummary("cache", null);
    applyFilters();
    renderOperations();
    renderScanStatus();
    updateConnection();
    if (new URLSearchParams(window.location.search).get("view") === "operations") switchWorkspace("operations");
  } catch (error) {
    showToast(`無法讀取瀏覽器快取：${error.message}`);
  }
  showTokenDialog();
}

for (const selector of ["#searchInput", "#typeFilter", "#sortField", "#sortDirection", "#pageSize"]) $(selector).addEventListener("input", () => { state.page = 1; applyFilters(); });
$("#previousPage").addEventListener("click", () => { state.page -= 1; renderRows(); });
$("#nextPage").addEventListener("click", () => { state.page += 1; renderRows(); });
$("#exportButton").addEventListener("click", exportCsv);
$("#refreshButton").addEventListener("click", refreshRelationships);
$("#logoutButton").addEventListener("click", () => { forgetToken(); showTokenDialog(); });
$("#clearCacheButton").addEventListener("click", () => $("#confirmDialog").showModal());
$("#confirmDialog").addEventListener("close", (event) => { if (event.target.returnValue === "confirm") clearCache(); });
$("#relationshipRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-id]");
  if (!button) return;
  const userId = button.dataset.removeId;
  if (event.shiftKey) return removeFriend(userId);
  const item = state.all.find((entry) => entry.id === userId);
  if (!item) return;
  state.pendingRemoveId = userId;
  $("#removeFriendName").textContent = item.display_name;
  $("#removeFriendDialog").returnValue = "";
  $("#removeFriendDialog").showModal();
});
$("#removeFriendDialog").addEventListener("close", (event) => { if (event.target.returnValue === "confirm" && state.pendingRemoveId) removeFriend(state.pendingRemoveId); state.pendingRemoveId = null; });
$("#startScanButton").addEventListener("click", () => $("#startScanDialog").showModal());
$("#startScanDialog").addEventListener("close", (event) => { if (event.target.returnValue === "confirm") startMessageScan(); });
$("#pauseScanButton").addEventListener("click", pauseMessageScan);
$("#friendsSidebar .nav-item").addEventListener("click", (event) => selectNavigation("all", event.currentTarget));
$("#friendsNav").addEventListener("click", (event) => selectNavigation("friend", event.currentTarget));
$("#outgoingNav").addEventListener("click", (event) => selectNavigation("outgoing_request", event.currentTarget));
$("#friendsWorkspaceButton").addEventListener("click", () => switchWorkspace("friends"));
$("#operationsWorkspaceButton").addEventListener("click", () => switchWorkspace("operations"));
$("#operationSearch").addEventListener("input", renderOperations);
document.querySelectorAll("[data-operation-filter]").forEach((button) => button.addEventListener("click", () => { state.operationFilter = button.dataset.operationFilter; document.querySelectorAll("[data-operation-filter]").forEach((item) => item.classList.remove("active")); button.classList.add("active"); renderOperations(); }));
$("#operationRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-readd-id]");
  if (!button) return;
  const operation = state.operations.find((item) => item.id === button.dataset.readdId);
  if (!operation) return;
  state.pendingReaddId = operation.id;
  $("#readdFriendName").textContent = operation.user.display_name || operation.user.id;
  $("#readdFriendDialog").returnValue = "";
  $("#readdFriendDialog").showModal();
});
$("#readdFriendDialog").addEventListener("close", (event) => { if (event.target.returnValue === "confirm" && state.pendingReaddId) readdFriend(state.pendingReaddId); state.pendingReaddId = null; });
$("#tokenForm").addEventListener("submit", connect);
$("#tokenDialog").addEventListener("cancel", (event) => event.preventDefault());
window.addEventListener("pagehide", forgetToken);

initialise();

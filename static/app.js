const state = {
  all: [],
  filtered: [],
  page: 1,
  pageSize: 100,
  csrfToken: "",
  pendingRemoveId: null,
  removingId: null,
};

const TYPE_LABELS = {
  friend: "好友",
  blocked: "封鎖",
  incoming_request: "收到的邀請",
  outgoing_request: "送出的邀請",
  implicit: "其他",
  suggestion: "建議",
  none: "無",
  unknown: "未知",
};

const FLAG_LABELS = [
  [1, "Discord 員工"], [2, "合作夥伴"], [4, "HypeSquad 活動"],
  [8, "Bug Hunter I"], [64, "Bravery"], [128, "Brilliance"],
  [256, "Balance"], [512, "早期支持者"], [16384, "Bug Hunter II"],
  [131072, "早期機器人開發者"], [262144, "認證版主"], [4194304, "Active Developer"],
];

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(date);
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
  const result = typeof left === "number"
    ? left - right
    : String(left).localeCompare(String(right), "zh-Hant", { numeric: true, sensitivity: "base" });
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
    const haystack = [item.display_name, item.username, item.id, item.note, item.nickname, item.guild_tag]
      .filter(Boolean).join(" ").toLocaleLowerCase("zh-Hant");
    return haystack.includes(query);
  }).sort((a, b) => compareValues(a[field], b[field], direction));

  const maxPage = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  state.page = Math.min(state.page, maxPage);
  renderRows();
}

function renderRows() {
  const start = (state.page - 1) * state.pageSize;
  const visible = state.filtered.slice(start, start + state.pageSize);
  const body = $("#relationshipRows");

  if (!visible.length) {
    body.innerHTML = '<div class="empty">沒有符合條件的資料</div>';
  } else {
    body.innerHTML = visible.map((item) => `
      <article class="friend-row" data-id="${escapeHtml(item.id)}">
        <div class="user">
          <div class="avatar-wrap" aria-hidden="true">
            <div class="avatar-fallback">${escapeHtml(initials(item))}</div>
            ${item.avatar_url ? `<img class="avatar" src="${escapeHtml(item.avatar_url)}" alt="" loading="lazy">` : ""}
          </div>
          <div>
            <div class="user-name" title="${escapeHtml(item.display_name)}">${escapeHtml(item.display_name)}</div>
            <div class="user-handle" title="${escapeHtml(item.id)}">@${escapeHtml(item.username)} · ${escapeHtml(item.id)}</div>
          </div>
        </div>
        <div class="cell relation-cell"><span class="relation ${escapeHtml(item.type_name)}">${escapeHtml(TYPE_LABELS[item.type_name] || "未知")}</span></div>
        <div class="cell since-cell">${escapeHtml(formatDate(item.since))}</div>
        <div class="cell created-cell">${escapeHtml(formatDate(item.account_created_at))}</div>
        <div class="cell last-message-cell">${escapeHtml(formatDate(item.last_message_at))}</div>
        <div class="row-actions">
          ${item.type_name === "friend" ? `<button class="remove-friend" type="button" data-remove-id="${escapeHtml(item.id)}" title="按住 Shift 可跳過確認">移除好友</button>` : `<span class="cell flags" title="${escapeHtml(flagNames(item.public_flags))}">${escapeHtml(item.guild_tag || flagNames(item.public_flags))}</span>`}
        </div>
      </article>
    `).join("");
    body.querySelectorAll(".avatar").forEach((image) => {
      image.addEventListener("error", () => image.remove());
    });
  }

  const pageCount = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
  $("#resultCount").textContent = `${state.filtered.length.toLocaleString("zh-TW")} 筆結果`;
  $("#pageStatus").textContent = `第 ${state.page} / ${pageCount} 頁`;
  $("#previousPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= pageCount;
}

function renderSummary(payload) {
  const items = payload.relationships;
  $("#totalCount").textContent = items.length.toLocaleString("zh-TW");
  $("#friendCount").textContent = items.filter((item) => item.type_name === "friend").length.toLocaleString("zh-TW");
  $("#outgoingCount").textContent = items.filter((item) => item.type_name === "outgoing_request").length.toLocaleString("zh-TW");
  $("#notedCount").textContent = items.filter((item) => item.note).length.toLocaleString("zh-TW");
  $("#sourceBadge").textContent = payload.source === "cache" ? "本機快取" : "剛從 Discord 取得";
  $("#fetchedAt").textContent = `擷取於 ${formatDate(payload.fetched_at)}`;
}

function updateCounts() {
  renderSummary({
    relationships: state.all,
    source: "cache",
    fetched_at: $("#fetchedAt").dataset.fetchedAt,
  });
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function exportCsv() {
  const headers = ["ID", "顯示名稱", "使用者名稱", "關係", "成為好友時間", "帳號建立時間", "最後訊息時間", "自訂暱稱", "備註", "Guild Tag", "公開旗標"];
  const rows = state.filtered.map((item) => [
    item.id, item.display_name, item.username, TYPE_LABELS[item.type_name] || item.type_name,
    item.since, item.account_created_at, item.last_message_at, item.nickname, item.note, item.guild_tag,
    flagNames(item.public_flags),
  ]);
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
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 4500);
}

async function clearCache() {
  try {
    const response = await fetch("/api/cache", {
      method: "DELETE",
      headers: { "X-CSRF-Token": state.csrfToken },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "清除失敗");
    showToast(result.message);
    $("#sourceBadge").textContent = "快取已清除";
  } catch (error) {
    showToast(`無法清除快取：${error.message}`);
  }
}

async function removeFriend(userId) {
  if (state.removingId) {
    showToast("請等待目前的移除操作完成。");
    return;
  }
  const item = state.all.find((entry) => entry.id === userId);
  if (!item || item.type_name !== "friend") return;

  state.removingId = userId;
  const button = document.querySelector(`[data-remove-id="${CSS.escape(userId)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "移除中…";
  }
  try {
    const response = await fetch(`/api/relationships/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { "X-CSRF-Token": state.csrfToken },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "移除失敗");
    state.all = state.all.filter((entry) => entry.id !== userId);
    applyFilters();
    updateCounts();
    showToast(`已移除 ${item.display_name}`);
  } catch (error) {
    showToast(error.message);
    if (button) {
      button.disabled = false;
      button.textContent = "移除好友";
    }
  } finally {
    state.removingId = null;
  }
}

function selectNavigation(type, button) {
  $("#typeFilter").value = type;
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  state.page = 1;
  applyFilters();
}

async function initialise() {
  try {
    const [dataResponse, statusResponse] = await Promise.all([
      fetch("/api/relationships", { cache: "no-store" }),
      fetch("/api/status", { cache: "no-store" }),
    ]);
    if (!dataResponse.ok || !statusResponse.ok) throw new Error("本機 API 回應失敗");
    const [payload, status] = await Promise.all([dataResponse.json(), statusResponse.json()]);
    state.all = payload.relationships;
    state.csrfToken = status.csrf_token;
    $("#fetchedAt").dataset.fetchedAt = payload.fetched_at;
    renderSummary(payload);
    applyFilters();
  } catch (error) {
    $("#relationshipRows").innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    showToast("資料載入失敗，請重新啟動程式。");
  }
}

["#searchInput", "#typeFilter", "#sortField", "#sortDirection", "#pageSize"].forEach((selector) => {
  $(selector).addEventListener("input", () => { state.page = 1; applyFilters(); });
});
$("#previousPage").addEventListener("click", () => { state.page -= 1; renderRows(); });
$("#nextPage").addEventListener("click", () => { state.page += 1; renderRows(); });
$("#exportButton").addEventListener("click", exportCsv);
$("#clearCacheButton").addEventListener("click", () => $("#confirmDialog").showModal());
$("#confirmDialog").addEventListener("close", (event) => {
  if (event.target.returnValue === "confirm") clearCache();
});
$("#relationshipRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-id]");
  if (!button) return;
  const userId = button.dataset.removeId;
  if (event.shiftKey) {
    removeFriend(userId);
    return;
  }
  const item = state.all.find((entry) => entry.id === userId);
  if (!item) return;
  state.pendingRemoveId = userId;
  $("#removeFriendName").textContent = item.display_name;
  $("#removeFriendDialog").returnValue = "";
  $("#removeFriendDialog").showModal();
});
$("#removeFriendDialog").addEventListener("close", (event) => {
  if (event.target.returnValue === "confirm" && state.pendingRemoveId) {
    removeFriend(state.pendingRemoveId);
  }
  state.pendingRemoveId = null;
});
$(".nav-item.active").addEventListener("click", (event) => selectNavigation("all", event.currentTarget));
$("#friendsNav").addEventListener("click", (event) => selectNavigation("friend", event.currentTarget));
$("#outgoingNav").addEventListener("click", (event) => selectNavigation("outgoing_request", event.currentTarget));

initialise();

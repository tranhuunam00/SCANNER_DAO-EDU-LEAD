const STORAGE_KEY = "daoEduLeadScannerItems";
const META_KEY = "daoEduLeadScannerMeta";
const SCANNED_URLS_KEY = "daoEduLeadScannerScannedPostUrls";
const API_BASE_URL_KEY = "daoEduLeadScannerApiBaseUrl";
const SYNC_STATE_KEY = "daoEduLeadScannerSyncState";
const BATCH_CONFIG_KEY = "daoEduLeadScannerBatchConfig";
const MIN_PARSER_VERSION = 21;
const RUNTIME_CONFIG = window.DaoEduScannerConfig || {};
const DEFAULT_API_BASE_URL =
  RUNTIME_CONFIG.apiBaseUrl || "http://103.90.227.173:5000/api";
const SYNC_ENDPOINT = normalizeSyncEndpoint(
  RUNTIME_CONFIG.syncEndpoint || "/facebook-lead-scans",
);

const scanButton = document.getElementById("scan");
const postUrlInput = document.getElementById("postUrl");
const forceStopButton = document.getElementById("forceStop");
const syncBackendButton = document.getElementById("syncBackend");
const forceSyncTemButton = document.getElementById("forceSyncTem");
const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const batchCountInput = document.getElementById("batchCount");
const batchPostTimeInput = document.getElementById("batchPostTime");
const batchTotalTimeInput = document.getElementById("batchTotalTime");
const batchIgnoreScannedInput = document.getElementById("batchIgnoreScanned");
const batchButton = document.getElementById("batch");
const continueBatchButton = document.getElementById("continueBatch");
const stopBatchButton = document.getElementById("stopBatch");
const statusNode = document.getElementById("status");
const syncStateNode = document.getElementById("syncState");
const syncMessageNode = document.getElementById("syncMessage");
const previewNode = document.getElementById("preview");

scanButton.addEventListener("click", runDeepScan);
forceStopButton.addEventListener("click", forceStopAll);
syncBackendButton.addEventListener("click", syncToBackend);
forceSyncTemButton.addEventListener("click", async () => {
  setSyncMessage("Đang tải lại tem từ BE...");
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Chưa mở tab Facebook nào.");
    
    await ensureContentScript(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { type: "FORCE_SYNC_SCANNED_POSTS" });
    
    if (res?.ok) {
      setSyncMessage("Đã tải xong tem từ BE!", false);
    } else {
      throw new Error("BE không phản hồi hoặc từ chối kết nối.");
    }
  } catch (err) {
    if (String(err.message).includes("Receiving end does not exist")) {
      setSyncMessage("Vui lòng tải lại trang (F5) Facebook trước khi đồng bộ.", true);
    } else {
      setSyncMessage(err.message || "Lỗi kết nối tải tem.", true);
    }
  }
});
apiBaseUrlInput.addEventListener("change", () =>
  saveSyncSettings().catch((error) =>
    setSyncMessage(error.message || "Không lưu được cấu hình BE.", true),
  ),
);

batchButton.addEventListener("click", () => startBatch(false));
continueBatchButton.addEventListener("click", () => startBatch(true));
stopBatchButton.addEventListener("click", () => stopBatchScan(true));

initializePopup();
window.setInterval(loadBatchState, 1000);

async function initializePopup() {
  await loadSyncSettings();
  await loadStoredData();
  await loadBatchState();
  loadBatchConfig();



  apiBaseUrlInput.onchange = () => saveSyncSettings();

  batchButton.onclick = () => {
    saveBatchConfig();
    startBatch(false);
  };
  continueBatchButton.onclick = () => {
    saveBatchConfig();
    startBatch(true);
  };
  stopBatchButton.onclick = () => stopBatchScan(true);
}

async function runDeepScan() {
  setBusy(true);
  setStatus("Đang quét sâu toàn bộ bình luận...");

  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const inputUrl = normalizeInputPostUrl(postUrlInput.value);
    if (postUrlInput.value.trim() && !inputUrl) {
      throw new Error("Link không hợp lệ. Hãy dán link bài viết Facebook.");
    }
    if (!tab?.id) throw new Error("Không tìm thấy tab đang mở.");
    if (!inputUrl && !isFacebookUrl(tab.url)) {
      throw new Error("Hãy mở bài viết Facebook hoặc dán link bài cần quét.");
    }
    if (inputUrl) {
      setStatus("Đang mở bài viết từ link...");
      tab = await chrome.tabs.update(tab.id, { url: inputUrl });
      await waitForTabComplete(tab.id, inputUrl);
    }

    await ensureContentScript(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "DEEP_SCAN_CURRENT_POST",
      maxRounds: 20,
      maxClicksPerRound: 40,
    });

    if (!result?.ok) {
      throw new Error(result?.error || "Không đọc được nội dung Facebook.");
    }

    const existing = await getStoredItems();
    const retained = existing.filter(
      (item) => item.pageUrl !== result.summary.postUrl,
    );
    const merged = mergeItems(retained, result.items);
    const meta = {
      scannedAt: new Date().toISOString(),
      pageUrl: tab.url,
      pageTitle: tab.title || "",
      lastPostCount: result.summary.posts,
      lastCommentCount: result.summary.comments,
      clickedExpanders: result.summary.clickedExpanders || 0,
      visibleArticles: result.summary.visibleArticles,
      topLevelArticles: result.summary.topLevelArticles,
      postDetected: result.summary.postDetected,
      postUrl: result.summary.postUrl,
    };

    await chrome.storage.local.set({
      [STORAGE_KEY]: merged,
      [META_KEY]: meta,
    });
    await markPostScanned(result.summary.postUrl);
    await reconcileSyncState(merged, meta);

    render(merged, meta);
    await analyzeAndRenderLeads(merged);
    const postNote = result.summary.postDetected
      ? ""
      : " Không thấy nội dung chữ của bài gốc nên đã lưu post rỗng.";
    setStatus(
      `Đã quét ${result.summary.posts} bài và ${result.summary.comments} bình luận.${postNote}`,
    );
  } catch (error) {
    setStatus(error.message || "Quét thất bại.", true);
  } finally {
    setBusy(false);
  }
}

async function loadStoredData() {
  const data = await chrome.storage.local.get([STORAGE_KEY, META_KEY]);
  const storedItems = data[STORAGE_KEY] || [];
  const items = filterValidItems(storedItems);
  if (items.length !== storedItems.length) {
    await chrome.storage.local.set({ [STORAGE_KEY]: items });
    await chrome.storage.local.remove([
      META_KEY,
      LEAD_ANALYSIS_KEY,
      SCANNED_URLS_KEY,
    ]);
  }
  await reconcileSyncState(items, data[META_KEY] || null);
  render(items, data[META_KEY] || null);
}

async function getStoredItems() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return filterValidItems(data[STORAGE_KEY] || []);
}

function filterValidItems(items) {
  return items.filter(
    (item) => Number(item.parserVersion || 0) >= MIN_PARSER_VERSION,
  );
}

async function markPostScanned(postUrl) {
  if (!postUrl) return;
  const data = await chrome.storage.local.get(SCANNED_URLS_KEY);
  const urls = new Set(data[SCANNED_URLS_KEY] || []);
  urls.add(normalizePostUrl(postUrl));
  await chrome.storage.local.set({ [SCANNED_URLS_KEY]: [...urls] });
}

function mergeItems(existing, incoming) {
  const map = new Map(existing.map((item) => [item.fingerprint, item]));
  for (const item of incoming) {
    map.set(item.fingerprint, {
      ...map.get(item.fingerprint),
      ...item,
      lastSeenAt: new Date().toISOString(),
    });
  }
  return [...map.values()].sort((a, b) =>
    String(b.capturedAt).localeCompare(String(a.capturedAt)),
  );
}

function render(items, meta) {
  const posts = items.filter((item) => item.kind === "POST");
  const comments = items.filter((item) => item.kind === "COMMENT");

  document.getElementById("postCount").textContent = posts.length;
  document.getElementById("commentCount").textContent = comments.length;
  document.getElementById("savedCount").textContent = items.length;
  document.getElementById("scanTime").textContent = meta?.scannedAt
    ? new Date(meta.scannedAt).toLocaleString("vi-VN")
    : "";

  if (!items.length) {
    previewNode.innerHTML = '<div class="empty">Chưa có dữ liệu.</div>';
    return;
  }

  previewNode.innerHTML = items
    .slice(0, 20)
    .map(
      (item) => `
        <article class="item">
          <div class="item-top">
            ${
              item.authorUrl
                ? `<a class="author-link" href="${escapeHtml(item.authorUrl)}" target="_blank" title="Mở trang cá nhân">${escapeHtml(item.authorName || "Mở trang cá nhân")}</a>`
                : `<strong>${escapeHtml(item.authorName || "Không rõ tác giả")}</strong>`
            }
            <span class="tag">${item.kind === "POST" ? "Bài viết" : "Bình luận"}</span>
          </div>
          <p>${escapeHtml(item.text || "(Không có nội dung chữ)")}</p>
        </article>
      `,
    )
    .join("");
}



async function forceStopAll() {
  if (!confirm("Ép buộc dừng và xóa mọi tiến trình ngầm đang chạy?")) return;
  await chrome.runtime.sendMessage({ type: "STOP_BATCH_SCAN" }).catch(() => {});
  await chrome.storage.local.remove([
    "daoEduLeadScannerBatchState",
    "daoEduLeadScannerBatchAttemptedUrls"
  ]);
  window.location.reload();
}

async function syncToBackend() {
  setBusy(true);
  setSyncMessage("Đang đồng bộ dữ liệu lên BE...");

  try {
    const items = await getStoredItems();
    if (!items.length) {
      throw new Error("Chưa có dữ liệu local để đồng bộ.");
    }

    await saveSyncSettings();
    const data = await chrome.storage.local.get([
      META_KEY,
      API_BASE_URL_KEY,
      SYNC_STATE_KEY,
    ]);
    const meta = data[META_KEY] || {};
    const postUrl =
      meta.postUrl ||
      meta.pageUrl ||
      items[0]?.pageUrl ||
      items[0]?.sourceUrl ||
      "";
    const previousState = data[SYNC_STATE_KEY] || null;
    const scanSessionId = shouldReuseSyncSession(
      previousState,
      items.length,
      postUrl,
    )
      ? previousState.scanSessionId
      : crypto.randomUUID();
    const nextState = {
      status: "SYNCING",
      scanSessionId,
      itemCount: items.length,
      postUrl,
      lastAttemptAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: nextState });
    renderSyncState(nextState);

    const apiBaseUrl =
      normalizeApiBaseUrl(data[API_BASE_URL_KEY]) || DEFAULT_API_BASE_URL;
    const response = await fetch(buildApiUrl(apiBaseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "DAO_EDU_FACEBOOK_EXTENSION",
        scanSessionId,
        exportedAt: new Date().toISOString(),
        meta: {
          ...meta,
          extensionVersion: chrome.runtime.getManifest().version,
        },
        items,
      }),
    });
    const result = await readSyncResponse(response);
    if (!response.ok || result?.ok === false) {
      throw new Error(
        result?.message ||
          result?.error ||
          `BE trả lỗi ${response.status}. Vui lòng thử lại.`,
      );
    }

    await chrome.storage.local.remove([
      STORAGE_KEY,
      META_KEY,
    ]);
    const syncedState = {
      status: "SYNCED",
      scanSessionId,
      scanId: result.scanId || "",
      itemCount: items.length,
      acceptedItems: Number(result.acceptedItems || 0),
      duplicateItems: Number(result.duplicateItems || 0),
      postUrl,
      syncedAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: syncedState });
    render([], null);
    renderLeadAnalysis(window.DaoEduLeadFilter.analyze([]));
    renderSyncState(syncedState);
    setStatus(
      `Đã đồng bộ ${items.length} item lên BE. Local raw đã được xóa để tránh nhiễu.`,
    );
  } catch (error) {
    const message = error.message || "Không thể đồng bộ BE.";
    const data = await chrome.storage.local.get(SYNC_STATE_KEY);
    const failedState = {
      ...(data[SYNC_STATE_KEY] || {}),
      status: "FAILED",
      lastError: message,
      lastAttemptAt: new Date().toISOString(),
    };
    await chrome.storage.local.set({ [SYNC_STATE_KEY]: failedState });
    renderSyncState(failedState);
    setStatus(message, true);
  } finally {
    setBusy(false);
  }
}

async function loadSyncSettings() {
  const data = await chrome.storage.local.get([
    API_BASE_URL_KEY,
    SYNC_STATE_KEY,
  ]);
  apiBaseUrlInput.value = data[API_BASE_URL_KEY] || DEFAULT_API_BASE_URL;
  renderSyncState(data[SYNC_STATE_KEY] || null);
}

async function reconcileSyncState(items, meta) {
  if (!items.length) return;
  const data = await chrome.storage.local.get(SYNC_STATE_KEY);
  const state = data[SYNC_STATE_KEY] || null;
  const postUrl =
    meta?.postUrl ||
    meta?.pageUrl ||
    items[0]?.pageUrl ||
    items[0]?.sourceUrl ||
    "";
  const itemCount = items.length;
  if (
    (state?.status === "FAILED" || state?.status === "SYNCING") &&
    shouldReuseSyncSession(state, itemCount, postUrl)
  ) {
    renderSyncState(state);
    return;
  }

  const alreadySynced =
    state?.status === "SYNCED" &&
    Number(state.itemCount || 0) === itemCount &&
    String(state.postUrl || "") === String(postUrl || "");
  if (alreadySynced) {
    renderSyncState(state);
    return;
  }

  const pendingState = {
    status: "PENDING",
    itemCount,
    postUrl,
    updatedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [SYNC_STATE_KEY]: pendingState });
  renderSyncState(pendingState);
}

async function saveSyncSettings() {
  const apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput.value);
  if (!apiBaseUrl) {
    setSyncMessage("API URL không hợp lệ.", true);
    throw new Error("API URL không hợp lệ.");
  }
  await chrome.storage.local.set({
    [API_BASE_URL_KEY]: apiBaseUrl,
    [SCANNER_TOKEN_KEY]: scannerTokenInput.value.trim(),
  });
  apiBaseUrlInput.value = apiBaseUrl;
}

function renderSyncState(state) {
  syncMessageNode.classList.remove("error");
  if (!state) {
    syncStateNode.textContent = "Chưa đồng bộ";
    syncMessageNode.textContent = `BE: ${apiBaseUrlInput.value || DEFAULT_API_BASE_URL}`;
    return;
  }

  if (state.status === "SYNCED") {
    syncStateNode.textContent = "Đã đồng bộ";
    syncMessageNode.textContent = `Scan ${state.scanId || state.scanSessionId} · ${
      state.itemCount || 0
    } item · ${formatSyncTime(state.syncedAt)}`;
    return;
  }

  if (state.status === "FAILED") {
    syncStateNode.textContent = "Lỗi sync";
    setSyncMessage(
      `${state.lastError || "Đồng bộ thất bại."} Dữ liệu local vẫn được giữ để retry.`,
      true,
    );
    return;
  }

  if (state.status === "PENDING") {
    syncStateNode.textContent = "Chưa sync";
    syncMessageNode.textContent = `${state.itemCount || 0} item local đang chờ đồng bộ BE.`;
    return;
  }

  if (state.status === "SYNCING") {
    syncStateNode.textContent = "Đang sync";
    syncMessageNode.textContent = `Đang gửi ${state.itemCount || 0} item lên BE...`;
    return;
  }

  syncStateNode.textContent = "Chưa đồng bộ";
  syncMessageNode.textContent = "";
}

function setSyncMessage(message, isError = false) {
  syncMessageNode.textContent = message;
  syncMessageNode.classList.toggle("error", isError);
}

function shouldReuseSyncSession(state, itemCount, postUrl) {
  return (
    state &&
    ["FAILED", "SYNCING"].includes(state.status) &&
    state.scanSessionId &&
    Number(state.itemCount || 0) === itemCount &&
    String(state.postUrl || "") === String(postUrl || "")
  );
}

async function readSyncResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const message = await response.text();
  return { message };
}

function normalizeApiBaseUrl(value) {
  const input = String(value || DEFAULT_API_BASE_URL).trim();
  try {
    const url = new URL(input);
    url.hash = "";
    url.search = "";
    let normalized = url.toString().replace(/\/+$/, "");
    if (normalized.endsWith(SYNC_ENDPOINT)) {
      normalized = normalized.slice(0, -SYNC_ENDPOINT.length);
    }
    const baseUrl = new URL(normalized);
    if (baseUrl.pathname === "/") {
      baseUrl.pathname = "/api";
      normalized = baseUrl.toString().replace(/\/+$/, "");
    }
    return normalized;
  } catch {
    return "";
  }
}

function normalizeSyncEndpoint(value) {
  const endpoint = String(value || "/facebook-lead-scans").trim();
  const withLeadingSlash = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  return withLeadingSlash.replace(/\/+$/, "") || "/facebook-lead-scans";
}

function buildApiUrl(apiBaseUrl) {
  return `${apiBaseUrl}${SYNC_ENDPOINT}`;
}

function formatSyncTime(value) {
  return value ? new Date(value).toLocaleString("vi-VN") : "";
}

function buildRawPostTree(items) {
  const groups = new Map();

  for (const item of items) {
    const key = item.postId || item.pageUrl || item.sourceUrl;
    if (!key) continue;
    const group = groups.get(key) || { post: null, comments: [] };
    if (item.kind === "POST") group.post = item;
    else if (item.kind === "COMMENT") group.comments.push(item);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map(({ post, comments }) => {
      const commentNodes = new Map(
        comments.map((comment) => [
          comment.fingerprint,
          { ...comment, replies: [] },
        ]),
      );
      const commentIds = new Map(
        [...commentNodes.values()]
          .filter((comment) => comment.commentId)
          .map((comment) => [comment.commentId, comment]),
      );
      const roots = [];

      for (const comment of commentNodes.values()) {
        const parent =
          commentIds.get(comment.parentCommentId) ||
          commentNodes.get(comment.parentFingerprint);
        if (parent && parent !== comment) parent.replies.push(comment);
        else roots.push(comment);
      }

      sortCommentTree(roots);
      return {
        ...(post || createMissingPost(comments[0])),
        comments: roots,
      };
    })
    .sort((a, b) =>
      String(b.capturedAt || "").localeCompare(String(a.capturedAt || "")),
    );
}

function createMissingPost(comment) {
  return {
    kind: "POST",
    postId: comment?.postId || "",
    groupUrl: comment?.groupUrl || "",
    pageUrl: comment?.pageUrl || "",
    sourceUrl: comment?.pageUrl || "",
    authorName: "",
    authorUrl: "",
    text: "",
    capturedAt: comment?.capturedAt || "",
    missingPostContent: true,
  };
}

function sortCommentTree(comments) {
  comments.sort((a, b) =>
    String(a.capturedAt || "").localeCompare(String(b.capturedAt || "")),
  );
  for (const comment of comments) sortCommentTree(comment.replies);
}

async function downloadJson(payload, filename) {
  const url = URL.createObjectURL(
    new Blob([payload], { type: "application/json" }),
  );
  await chrome.downloads.download({ url, filename, saveAs: true });
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function clearStorage() {
  await chrome.storage.local.remove([
    STORAGE_KEY,
    META_KEY,
    LEAD_ANALYSIS_KEY,
    SYNC_STATE_KEY,
  ]);
  render([], null);
  renderLeadAnalysis(window.DaoEduLeadFilter.analyze([]));
  renderSyncState(null);
  setStatus("Đã xóa dữ liệu lưu tạm.");
}

async function clearAllCache() {
  const confirmed = window.confirm(
    "Xóa toàn bộ dữ liệu, lịch sử bài đã quét và trạng thái quét?",
  );
  if (!confirmed) return;

  setBusy(true);
  clearAllButton.disabled = true;
  try {
    await stopBatchScan(false);
    await chrome.storage.local.clear();
    render([], null);
    renderLeadAnalysis(window.DaoEduLeadFilter.analyze([]));

    const panel = document.getElementById("batchPanel");
    const progress = document.getElementById("batchProgress");
    panel.classList.add("hidden");
    progress.style.width = "0%";
    continueBatchButton.classList.add("hidden");
    await loadSyncSettings();
    setStatus("Đã xóa toàn bộ cache. Có thể quét lại từ đầu.");
  } finally {
    setBusy(false);
    clearAllButton.disabled = false;
  }
}

function setBusy(busy) {
  scanButton.disabled = busy;
  postUrlInput.disabled = busy;
  syncBackendButton.disabled = busy;
  forceSyncTemButton.disabled = busy;
  apiBaseUrlInput.disabled = busy;
  batchButton.disabled = busy;
  continueBatchButton.disabled = busy;
  forceStopButton.disabled = busy;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle("error", isError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isFacebookUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return ["www.facebook.com", "web.facebook.com", "m.facebook.com"].includes(
      hostname,
    );
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "PING_SCANNER",
    });
    if (response?.ok) return;
  } catch {
    // The page was opened before the extension was installed or reloaded.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["batch-queue.js", "content.js"],
  });
  await sleep(150);
}

function normalizeInputPostUrl(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  try {
    const url = new URL(input);
    const allowedHost = [
      "www.facebook.com",
      "web.facebook.com",
      "m.facebook.com",
      "facebook.com",
    ].includes(url.hostname);
    const isGroupPost = /\/groups\/[^/?#]+\/(?:posts|permalink)\/[^/?#]+/.test(
      url.pathname,
    );
    const isSharePost = /^\/share\/p\/[^/]+\/?$/.test(url.pathname);
    if (!allowedHost || (!isGroupPost && !isSharePost)) {
      return "";
    }
    url.hostname = "www.facebook.com";
    url.hash = "";
    if (isGroupPost) url.search = "";
    return url.toString();
  } catch {
    return "";
  }
}

async function waitForTabComplete(tabId, expectedUrl) {
  const expectedIdentity = getPostIdentity(expectedUrl);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    const tab = await chrome.tabs.get(tabId);
    const actualIdentity = getPostIdentity(tab.url);
    if (
      tab.status === "complete" &&
      actualIdentity &&
      (!expectedIdentity || actualIdentity === expectedIdentity)
    ) {
      await sleep(800);
      return;
    }
    await sleep(250);
  }
  throw new Error("Facebook tải bài viết quá lâu. Hãy thử lại.");
}

function getPostIdentity(value) {
  try {
    const match = new URL(value).pathname.match(
      /\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)/,
    );
    return match ? `${match[1]}:${match[2]}` : "";
  } catch {
    return "";
  }
}

async function startBatch(continueBatch) {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id || !isFacebookUrl(tab.url)) {
      throw new Error("Hãy mở trang nhóm Facebook trước.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "START_GROUP_BATCH",
      sourceTabId: tab.id,
      continueBatch,
      config: getBatchConfig(),
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể bắt đầu quét hàng loạt.");
    }
    await loadBatchState();
  } catch (error) {
    setStatus(error.message || "Không thể quét hàng loạt.", true);
  }
}

async function stopBatchScan(showStatus) {
  stopBatchButton.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({
      type: "STOP_BATCH_SCAN",
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Không thể dừng job nền.");
    }
    await loadBatchState();
    if (showStatus) setStatus("Đã dừng và xóa job nền.");
  } catch (error) {
    if (showStatus) {
      setStatus(error.message || "Không thể dừng job nền.", true);
    }
  } finally {
    stopBatchButton.disabled = false;
  }
}

async function loadBatchState() {
  const response = await chrome.runtime.sendMessage({
    type: "GET_BATCH_STATE",
  });
  if (!response?.ok) return;

  const state = response.state;
  const panel = document.getElementById("batchPanel");
  const status = document.getElementById("batchStatus");
  const message = document.getElementById("batchMessage");
  const progress = document.getElementById("batchProgress");
  const visible = state.status !== "IDLE";

  panel.classList.toggle("hidden", !visible);
  status.textContent =
    state.status === "RUNNING"
      ? `${state.current}/${state.batchTotal}`
      : state.status === "AWAITING_CONTINUE"
        ? "Chờ tiếp tục"
        : state.status === "CANCELLED"
          ? "Đã dừng"
          : state.status === "ERROR"
            ? "Lỗi"
            : "Hoàn tất";
  message.textContent = state.message || "";
  progress.style.width = `${
    state.batchTotal ? Math.round((state.current / state.batchTotal) * 100) : 0
  }%`;

  const historyContainer = document.getElementById("batchHistory");
  if (historyContainer && state.history && state.history.length > 0) {
    historyContainer.innerHTML = state.history.map((item) => {
      const displayUrl = item.postUrl || "Bài viết";
      let shortUrl = displayUrl;
      try {
        const urlObj = new URL(displayUrl);
        const match = urlObj.pathname.match(/\/posts\/([^/]+)/) || urlObj.pathname.match(/\/permalink\/([^/]+)/);
        if (match) {
          shortUrl = `Bài viết #${match[1].slice(0, 10)}`;
        }
      } catch {}

      const isSuccess = item.status === 'SUCCESS';
      const badgeColor = isSuccess ? '#16a34a' : '#ef4444';
      const statusText = isSuccess ? `${item.comments} bình luận` : `Lỗi: ${item.error || 'không xác định'}`;

      return `
        <div class="batch-history-item">
          <a class="batch-history-link" href="${escapeHtml(displayUrl)}" target="_blank" title="${escapeHtml(displayUrl)}">${escapeHtml(shortUrl)}</a>
          <span class="batch-history-count" style="color: ${badgeColor}">${escapeHtml(statusText)}</span>
        </div>
      `;
    }).join("");
  } else if (historyContainer) {
    historyContainer.innerHTML = "";
  }

  const running = state.status === "RUNNING";
  batchButton.disabled = running;
  continueBatchButton.disabled = running;
  stopBatchButton.classList.toggle("hidden", !running);
  continueBatchButton.classList.toggle(
    "hidden",
    state.status !== "AWAITING_CONTINUE",
  );

  if (!running) await loadStoredData();
}

function normalizePostUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)/,
    );
    if (match) {
      url.hostname = "www.facebook.com";
      url.pathname = `/groups/${match[1]}/posts/${match[2]}/`;
    }
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return value;
  }
}

function getBatchConfig() {
  return {
    limit: parseInt(batchCountInput.value) || 10,
    postTimeoutSec: parseInt(batchPostTimeInput.value) || 120,
    totalTimeoutMin: parseInt(batchTotalTimeInput.value) || 30,
    ignoreScanned: batchIgnoreScannedInput.checked,
  };
}

function saveBatchConfig() {
  chrome.storage.local.set({ [BATCH_CONFIG_KEY]: getBatchConfig() });
}

function loadBatchConfig() {
  chrome.storage.local.get([BATCH_CONFIG_KEY]).then((data) => {
    const config = data[BATCH_CONFIG_KEY];
    if (!config) return;
    if (config.limit) batchCountInput.value = config.limit;
    if (config.postTimeoutSec) batchPostTimeInput.value = config.postTimeoutSec;
    if (config.totalTimeoutMin) batchTotalTimeInput.value = config.totalTimeoutMin;
    if (typeof config.ignoreScanned === "boolean") {
      batchIgnoreScannedInput.checked = config.ignoreScanned;
    }
  });
}

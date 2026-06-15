const STORAGE_KEY = 'daoEduLeadScannerItems';
const META_KEY = 'daoEduLeadScannerMeta';
const SCANNED_URLS_KEY = 'daoEduLeadScannerScannedPostUrls';
const LEAD_ANALYSIS_KEY = 'daoEduLeadScannerLeadAnalysis';
const MIN_PARSER_VERSION = 21;

const scanButton = document.getElementById('scan');
const postUrlInput = document.getElementById('postUrl');
const exportRawButton = document.getElementById('exportRaw');
const exportButton = document.getElementById('export');
const clearButton = document.getElementById('clear');
const clearAllButton = document.getElementById('clearAll');
const batchButton = document.getElementById('batch');
const continueBatchButton = document.getElementById('continueBatch');
const statusNode = document.getElementById('status');
const previewNode = document.getElementById('preview');

scanButton.addEventListener('click', runDeepScan);
exportRawButton.addEventListener('click', exportRawJson);
exportButton.addEventListener('click', exportJson);
clearButton.addEventListener('click', clearStorage);
clearAllButton.addEventListener('click', clearAllCache);
batchButton.addEventListener('click', () => startBatch(false));
continueBatchButton.addEventListener('click', () => startBatch(true));

loadStoredData();
loadBatchState();
window.setInterval(loadBatchState, 1000);

async function runDeepScan() {
  setBusy(true);
  setStatus('Đang quét sâu toàn bộ bình luận...');

  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const inputUrl = normalizeInputPostUrl(postUrlInput.value);
    if (postUrlInput.value.trim() && !inputUrl) {
      throw new Error('Link không hợp lệ. Hãy dán link bài viết Facebook.');
    }
    if (!tab?.id) throw new Error('Không tìm thấy tab đang mở.');
    if (!inputUrl && !isFacebookUrl(tab.url)) {
      throw new Error('Hãy mở bài viết Facebook hoặc dán link bài cần quét.');
    }
    if (inputUrl) {
      setStatus('Đang mở bài viết từ link...');
      tab = await chrome.tabs.update(tab.id, { url: inputUrl });
      await waitForTabComplete(tab.id, inputUrl);
    }

    await ensureContentScript(tab.id);

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'DEEP_SCAN_CURRENT_POST',
      maxRounds: 20,
      maxClicksPerRound: 40,
    });

    if (!result?.ok) {
      throw new Error(result?.error || 'Không đọc được nội dung Facebook.');
    }

    const existing = await getStoredItems();
    const retained = existing.filter(
      (item) => item.pageUrl !== result.summary.postUrl,
    );
    const merged = mergeItems(retained, result.items);
    const meta = {
      scannedAt: new Date().toISOString(),
      pageUrl: tab.url,
      pageTitle: tab.title || '',
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

    render(merged, meta);
    await analyzeAndRenderLeads(merged);
    const postNote = result.summary.postDetected
      ? ''
      : ' Không thấy nội dung chữ của bài gốc nên đã lưu post rỗng.';
    setStatus(
      `Đã quét ${result.summary.posts} bài và ${result.summary.comments} bình luận.${postNote}`,
    );
  } catch (error) {
    setStatus(error.message || 'Quét thất bại.', true);
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
  render(items, data[META_KEY] || null);
  await analyzeAndRenderLeads(items);
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
  const posts = items.filter((item) => item.kind === 'POST');
  const comments = items.filter((item) => item.kind === 'COMMENT');

  document.getElementById('postCount').textContent = posts.length;
  document.getElementById('commentCount').textContent = comments.length;
  document.getElementById('savedCount').textContent = items.length;
  document.getElementById('scanTime').textContent = meta?.scannedAt
    ? new Date(meta.scannedAt).toLocaleString('vi-VN')
    : '';

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
                ? `<a class="author-link" href="${escapeHtml(item.authorUrl)}" target="_blank" title="Mở trang cá nhân">${escapeHtml(item.authorName || 'Mở trang cá nhân')}</a>`
                : `<strong>${escapeHtml(item.authorName || 'Không rõ tác giả')}</strong>`
            }
            <span class="tag">${item.kind === 'POST' ? 'Bài viết' : 'Bình luận'}</span>
          </div>
          <p>${escapeHtml(item.text || '(Không có nội dung chữ)')}</p>
        </article>
      `,
    )
    .join('');
}

async function analyzeAndRenderLeads(items) {
  const analysis = window.DaoEduLeadFilter.analyze(items);
  await chrome.storage.local.set({ [LEAD_ANALYSIS_KEY]: analysis });
  renderLeadAnalysis(analysis);
}

function renderLeadAnalysis(analysis) {
  const summary = analysis.summary;
  const otherCount =
    summary.RECOMMENDATION + summary.NEUTRAL + summary.SPAM;
  document.getElementById('potentialCount').textContent =
    summary.POTENTIAL_PARENT;
  document.getElementById('teacherAdCount').textContent = summary.TEACHER_AD;
  document.getElementById('competitorCount').textContent =
    summary.COMPETITOR_SALE;
  document.getElementById('neutralCount').textContent = otherCount;
  document.getElementById('profileCount').textContent =
    `${summary.totalProfiles} hồ sơ`;

  const leadPreview = document.getElementById('leadPreview');
  if (!analysis.aiCandidates.length) {
    leadPreview.innerHTML =
      '<div class="empty">Chưa tìm thấy lead đủ điểm.</div>';
    return;
  }

  leadPreview.innerHTML = analysis.aiCandidates
    .slice(0, 10)
    .map((profile) => {
      const author = profile.authorUrl
        ? `<a class="author-link" href="${escapeHtml(profile.authorUrl)}" target="_blank">${escapeHtml(profile.authorName)}</a>`
        : `<strong>${escapeHtml(profile.authorName)}</strong>`;
      return `
        <article class="lead-card">
          <div class="lead-card-top">
            ${author}
            <span class="lead-score">${profile.leadScore}/100</span>
          </div>
          <p class="lead-reason">${escapeHtml(profile.reasons.join(' · '))}</p>
        </article>
      `;
    })
    .join('');
}

async function exportJson() {
  const data = await chrome.storage.local.get([
    STORAGE_KEY,
    META_KEY,
    LEAD_ANALYSIS_KEY,
  ]);
  const items = filterValidItems(data[STORAGE_KEY] || []);
  const leadAnalysis =
    data[LEAD_ANALYSIS_KEY] || window.DaoEduLeadFilter.analyze(items);
  const payload = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      meta: data[META_KEY] || null,
      filterVersion: 1,
      filterSummary: leadAnalysis.summary,
      aiCandidates: leadAnalysis.aiCandidates,
      leadProfiles: leadAnalysis.profiles,
      items,
    },
    null,
    2,
  );
  await downloadJson(
    payload,
    `dao-edu-facebook-scan-analyzed-${Date.now()}.json`,
  );
}

async function exportRawJson() {
  const items = await getStoredItems();
  const payload = JSON.stringify(buildRawPostTree(items), null, 2);
  await downloadJson(payload, `dao-edu-facebook-scan-raw-${Date.now()}.json`);
}

function buildRawPostTree(items) {
  const groups = new Map();

  for (const item of items) {
    const key = item.postId || item.pageUrl || item.sourceUrl;
    if (!key) continue;
    const group = groups.get(key) || { post: null, comments: [] };
    if (item.kind === 'POST') group.post = item;
    else if (item.kind === 'COMMENT') group.comments.push(item);
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
      String(b.capturedAt || '').localeCompare(String(a.capturedAt || '')),
    );
}

function createMissingPost(comment) {
  return {
    kind: 'POST',
    postId: comment?.postId || '',
    groupUrl: comment?.groupUrl || '',
    pageUrl: comment?.pageUrl || '',
    sourceUrl: comment?.pageUrl || '',
    authorName: '',
    authorUrl: '',
    text: '',
    capturedAt: comment?.capturedAt || '',
    missingPostContent: true,
  };
}

function sortCommentTree(comments) {
  comments.sort((a, b) =>
    String(a.capturedAt || '').localeCompare(String(b.capturedAt || '')),
  );
  for (const comment of comments) sortCommentTree(comment.replies);
}

async function downloadJson(payload, filename) {
  const url = URL.createObjectURL(
    new Blob([payload], { type: 'application/json' }),
  );
  await chrome.downloads.download({ url, filename, saveAs: true });
  window.setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function clearStorage() {
  await chrome.storage.local.remove([
    STORAGE_KEY,
    META_KEY,
    LEAD_ANALYSIS_KEY,
  ]);
  render([], null);
  renderLeadAnalysis(window.DaoEduLeadFilter.analyze([]));
  setStatus('Đã xóa dữ liệu lưu tạm.');
}

async function clearAllCache() {
  const confirmed = window.confirm(
    'Xóa toàn bộ dữ liệu, lịch sử bài đã quét và trạng thái quét?',
  );
  if (!confirmed) return;

  setBusy(true);
  clearAllButton.disabled = true;
  try {
    await chrome.storage.local.clear();
    render([], null);
    renderLeadAnalysis(window.DaoEduLeadFilter.analyze([]));

    const panel = document.getElementById('batchPanel');
    const progress = document.getElementById('batchProgress');
    panel.classList.add('hidden');
    progress.style.width = '0%';
    continueBatchButton.classList.add('hidden');
    setStatus('Đã xóa toàn bộ cache. Có thể quét lại từ đầu.');
  } finally {
    setBusy(false);
    clearAllButton.disabled = false;
  }
}

function setBusy(busy) {
  scanButton.disabled = busy;
  postUrlInput.disabled = busy;
  exportRawButton.disabled = busy;
  exportButton.disabled = busy;
  batchButton.disabled = busy;
  continueBatchButton.disabled = busy;
  clearAllButton.disabled = busy;
}

function setStatus(message, isError = false) {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', isError);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function sleep(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function isFacebookUrl(value) {
  try {
    const hostname = new URL(value).hostname;
    return [
      'www.facebook.com',
      'web.facebook.com',
      'm.facebook.com',
    ].includes(hostname);
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PING_SCANNER',
    });
    if (response?.ok) return;
  } catch {
    // The page was opened before the extension was installed or reloaded.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  });
  await sleep(150);
}

function normalizeInputPostUrl(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    const allowedHost = [
      'www.facebook.com',
      'web.facebook.com',
      'm.facebook.com',
      'facebook.com',
    ].includes(url.hostname);
    const isGroupPost =
      /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/.test(url.pathname);
    const isSharePost = /^\/share\/p\/[^/]+\/?$/.test(url.pathname);
    if (!allowedHost || (!isGroupPost && !isSharePost)) {
      return '';
    }
    url.hostname = 'www.facebook.com';
    url.hash = '';
    if (isGroupPost) url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

async function waitForTabComplete(tabId, expectedUrl) {
  const expectedIdentity = getPostIdentity(expectedUrl);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 20000) {
    const tab = await chrome.tabs.get(tabId);
    const actualIdentity = getPostIdentity(tab.url);
    if (
      tab.status === 'complete' &&
      actualIdentity &&
      (!expectedIdentity || actualIdentity === expectedIdentity)
    ) {
      await sleep(800);
      return;
    }
    await sleep(250);
  }
  throw new Error('Facebook tải bài viết quá lâu. Hãy thử lại.');
}

function getPostIdentity(value) {
  try {
    const match = new URL(value).pathname.match(
      /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/,
    );
    return match ? `${match[1]}:${match[2]}` : '';
  } catch {
    return '';
  }
}

async function startBatch(continueBatch) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isFacebookUrl(tab.url)) {
      throw new Error('Hãy mở trang nhóm Facebook trước.');
    }

    const response = await chrome.runtime.sendMessage({
      type: 'START_BATCH_SCAN',
      sourceTabId: tab.id,
      continueBatch,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Không thể bắt đầu quét hàng loạt.');
    }
    await loadBatchState();
  } catch (error) {
    setStatus(error.message || 'Không thể quét hàng loạt.', true);
  }
}

async function loadBatchState() {
  const response = await chrome.runtime.sendMessage({
    type: 'GET_BATCH_STATE',
  });
  if (!response?.ok) return;

  const state = response.state;
  const panel = document.getElementById('batchPanel');
  const status = document.getElementById('batchStatus');
  const message = document.getElementById('batchMessage');
  const progress = document.getElementById('batchProgress');
  const visible = state.status !== 'IDLE';

  panel.classList.toggle('hidden', !visible);
  status.textContent =
    state.status === 'RUNNING'
      ? `${state.current}/${state.batchTotal}`
      : state.status === 'AWAITING_CONTINUE'
        ? 'Chờ tiếp tục'
        : 'Hoàn tất';
  message.textContent = state.message || '';
  progress.style.width = `${
    state.batchTotal
      ? Math.round((state.current / state.batchTotal) * 100)
      : 0
  }%`;

  const running = state.status === 'RUNNING';
  batchButton.disabled = running;
  continueBatchButton.disabled = running;
  continueBatchButton.classList.toggle(
    'hidden',
    state.status !== 'AWAITING_CONTINUE',
  );

  if (!running) await loadStoredData();
}

function normalizePostUrl(value) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/,
    );
    if (match) {
      url.hostname = 'www.facebook.com';
      url.pathname = `/groups/${match[1]}/posts/${match[2]}/`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

const STORAGE_KEY = 'daoEduLeadScannerItems';
const META_KEY = 'daoEduLeadScannerMeta';
const SCANNED_URLS_KEY = 'daoEduLeadScannerScannedPostUrls';
const LEAD_ANALYSIS_KEY = 'daoEduLeadScannerLeadAnalysis';

const scanButton = document.getElementById('scan');
const expandButton = document.getElementById('expand');
const exportButton = document.getElementById('export');
const clearButton = document.getElementById('clear');
const batchButton = document.getElementById('batch');
const continueBatchButton = document.getElementById('continueBatch');
const statusNode = document.getElementById('status');
const previewNode = document.getElementById('preview');

scanButton.addEventListener('click', () => runScan(false));
expandButton.addEventListener('click', () => runScan(true));
exportButton.addEventListener('click', exportJson);
clearButton.addEventListener('click', clearStorage);
batchButton.addEventListener('click', () => startBatch(false));
continueBatchButton.addEventListener('click', () => startBatch(true));

loadStoredData();
loadBatchState();
window.setInterval(loadBatchState, 1000);

async function runScan(expandComments) {
  setBusy(true);
  setStatus(
    expandComments
      ? 'Đang thử mở thêm bình luận...'
      : 'Đang đọc nội dung trên trang...',
  );

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isFacebookUrl(tab.url)) {
      throw new Error('Hãy mở riêng một bài viết Facebook trước khi quét.');
    }

    await ensureContentScript(tab.id);

    let clickedExpanders = 0;
    if (expandComments) {
      const expansion = await expandAllComments(tab.id);
      clickedExpanders = expansion.clickedExpanders;
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: 'SCAN_VISIBLE_CONTENT',
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
      clickedExpanders,
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
      : ' Không thấy nội dung chữ của bài gốc nên không tạo bản ghi bài viết.';
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
  const items = data[STORAGE_KEY] || [];
  render(items, data[META_KEY] || null);
  await analyzeAndRenderLeads(items);
}

async function getStoredItems() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
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
  const items = data[STORAGE_KEY] || [];
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
  const url = URL.createObjectURL(
    new Blob([payload], { type: 'application/json' }),
  );
  await chrome.downloads.download({
    url,
    filename: `dao-edu-facebook-scan-${Date.now()}.json`,
    saveAs: true,
  });
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

function setBusy(busy) {
  scanButton.disabled = busy;
  expandButton.disabled = busy;
  batchButton.disabled = busy;
  continueBatchButton.disabled = busy;
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

async function expandAllComments(tabId) {
  const maxRounds = 10;
  let clickedExpanders = 0;
  let emptyRounds = 0;
  let previousScrollHeight = 0;

  for (let round = 1; round <= maxRounds; round += 1) {
    setStatus(
      `Đang mở bình luận vòng ${round}/${maxRounds}. Đã bấm ${clickedExpanders} nút...`,
    );

    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'EXPAND_COMMENTS',
    });
    if (!result?.ok) {
      throw new Error(result?.error || 'Không thể mở bình luận.');
    }

    const clickedThisRound = result.clickedExpanders || 0;
    clickedExpanders += clickedThisRound;
    const grew = (result.scrollHeight || 0) > previousScrollHeight;
    previousScrollHeight = Math.max(
      previousScrollHeight,
      result.scrollHeight || 0,
    );

    if (clickedThisRound === 0 && !grew) emptyRounds += 1;
    else emptyRounds = 0;

    if (emptyRounds >= 2) break;
    await sleep(clickedThisRound > 0 ? 1800 : 1000);
  }

  setStatus(
    `Đã mở ${clickedExpanders} nút bình luận/phản hồi. Đang tổng hợp dữ liệu...`,
  );
  await sleep(800);
  return { clickedExpanders };
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
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

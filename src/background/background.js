import {
  BATCH_STATE_KEY,
  BATCH_SIZE,
  API_URL_KEY,
  TOKEN_KEY,
  BATCH_ATTEMPTED_URLS_KEY,
} from '../constants';
const activeScanTabsByJob = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(BATCH_STATE_KEY);
  const state = data[BATCH_STATE_KEY];
  if (state?.status === 'RUNNING') {
    await stopBatch();
    return;
  }
  if (!state) await setBatchState(createIdleState());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'START_GROUP_BATCH') {
    startBatch(message.sourceTabId, message.continueBatch, message.config)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }

  if (message?.type === 'GET_BATCH_STATE') {
    getBatchState().then((state) => sendResponse({ ok: true, state }));
    return true;
  }

  if (message?.type === 'STOP_BATCH_SCAN') {
    stopBatch()
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }

  if (message?.type === 'SCAN_POST_IN_BACKGROUND_TAB') {
    scanPostInBackgroundTab(
      message.postUrl,
      message.jobId,
      _sender.tab?.windowId,
      message.config
    )
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }
});

async function startBatch(sourceTabId, continueBatch, config) {
  const currentState = await getBatchState();
  if (currentState.status === 'RUNNING') {
    throw new Error('Mot luot quet dang chay.');
  }

  const sourceTab = await chrome.tabs.get(sourceTabId);
  if (!sourceTab.url || !isFacebookGroupUrl(sourceTab.url)) {
    throw new Error('Hay mo trang nhom Facebook truoc.');
  }

  await ensureContentScript(sourceTabId);
  const jobId = crypto.randomUUID();
  const limit = config?.limit || 10;

  if (!continueBatch) {
    await chrome.storage.local.remove(BATCH_ATTEMPTED_URLS_KEY);
  }
  await setBatchState({
    status: 'RUNNING',
    message: 'Dang tim bai chua quet tren trang nhom...',
    current: 0,
    batchTotal: limit,
    processedTotal: continueBatch ? (currentState.processedTotal || 0) : 0,
    failedTotal: continueBatch ? (currentState.failedTotal || 0) : 0,
    jobId,
    cancelRequested: false,
    sourceTabId,
    sourceGroupUrl: sourceTab.url,
    activePostUrl: '',
    activeScanTabId: null,
    lastResult: null,
    history: currentState.history || [],
  });

  const response = await chrome.tabs.sendMessage(sourceTabId, {
    type: 'RUN_GROUP_BATCH',
    limit,
    config,
    jobId,
  });
  if (!response?.ok) {
    await updateBatchState({
      status: 'ERROR',
      message: response?.error || 'Khong the bat dau quet.',
    });
    throw new Error(response?.error || 'Khong the bat dau quet.');
  }

  return { ok: true };
}

async function stopBatch() {
  const state = await getBatchState();
  const jobId = state.jobId || '';
  const tabIds = new Set(activeScanTabsByJob.get(jobId) || []);
  if (Number.isInteger(state.activeScanTabId)) {
    tabIds.add(state.activeScanTabId);
  }

  const activePostId = getPostIdentity(state.activePostUrl);
  if (activePostId) {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (
        tab.id !== state.sourceTabId &&
        getPostIdentity(tab.url) === activePostId
      ) {
        tabIds.add(tab.id);
      }
    }
  }

  await setBatchState({
    ...state,
    status: 'CANCELLED',
    message: 'Da dung va xoa job nen.',
    cancelRequested: true,
    activePostUrl: '',
    activeScanTabId: null,
  });

  if (Number.isInteger(state.sourceTabId)) {
    await chrome.tabs
      .sendMessage(state.sourceTabId, {
        type: 'CANCEL_GROUP_BATCH',
        jobId,
      })
      .catch(() => {});
  }

  await Promise.all(
    [...tabIds].map((tabId) => chrome.tabs.remove(tabId).catch(() => {})),
  );
  activeScanTabsByJob.delete(jobId);
  return { ok: true };
}

async function scanPostInBackgroundTab(postUrl, jobId, windowId, config) {
  if (!isFacebookGroupPostUrl(postUrl)) {
    throw new Error('Link bai viet Facebook khong hop le.');
  }
  await assertBatchActive(jobId);

  let scanTab = null;
  try {
    scanTab = await chrome.tabs.create({
      url: normalizePostUrl(postUrl),
      active: true,
      ...(Number.isInteger(windowId) ? { windowId } : {}),
    });
    registerActiveScanTab(jobId, scanTab.id);
    await updateBatchState({
      activePostUrl: normalizePostUrl(postUrl),
      activeScanTabId: scanTab.id,
    });
    const postTimeoutMs = config?.postTimeoutMs || 120000;
    await waitForTabComplete(scanTab.id, postUrl, postTimeoutMs);
    await assertBatchActive(jobId);
    await ensureContentScript(scanTab.id);

    const result = await chrome.tabs.sendMessage(scanTab.id, {
      type: 'DEEP_SCAN_AND_SAVE_CURRENT_POST',
      maxTimeMs: postTimeoutMs,
    });
    if (!result?.ok) {
      throw new Error(result?.error || 'Khong doc duoc bai viet.');
    }
    await assertBatchActive(jobId);
    return { ok: true, summary: result.summary };
  } finally {
    if (scanTab?.id) {
      await chrome.tabs.remove(scanTab.id).catch(() => {});
      unregisterActiveScanTab(jobId, scanTab.id);
      const state = await getBatchState();
      if (state.jobId === jobId && state.activeScanTabId === scanTab.id) {
        await updateBatchState({
          activePostUrl: '',
          activeScanTabId: null,
        });
      }
    }
  }
}

async function assertBatchActive(jobId) {
  const state = await getBatchState();
  if (
    !jobId ||
    state.jobId !== jobId ||
    state.status !== 'RUNNING' ||
    state.cancelRequested
  ) {
    throw new Error('Job da bi dung.');
  }
}

function registerActiveScanTab(jobId, tabId) {
  const tabIds = activeScanTabsByJob.get(jobId) || new Set();
  tabIds.add(tabId);
  activeScanTabsByJob.set(jobId, tabIds);
}

function unregisterActiveScanTab(jobId, tabId) {
  const tabIds = activeScanTabsByJob.get(jobId);
  if (!tabIds) return;
  tabIds.delete(tabId);
  if (!tabIds.size) activeScanTabsByJob.delete(jobId);
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'PING_SCANNER',
    });
    if (response?.ok) return;
  } catch {
    // Inject below when the page predates the extension reload.
  }

  // Đọc đường dẫn thực tế từ manifest (CRXJS có thể đổi tên file)
  const manifest = chrome.runtime.getManifest();
  const scripts = manifest.content_scripts?.[0]?.js || [
    'assets/batch-queue.js',
    'assets/content.js',
  ];

  await chrome.scripting.executeScript({
    target: { tabId },
    files: scripts,
  });
  await sleep(250);
}

async function waitForTabComplete(tabId, expectedUrl, timeoutMilliseconds) {
  const expectedIdentity = getPostIdentity(expectedUrl);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMilliseconds) {
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

  throw new Error('Facebook tai bai viet qua lau.');
}

async function getBatchState() {
  const data = await chrome.storage.local.get(BATCH_STATE_KEY);
  return data[BATCH_STATE_KEY] || createIdleState();
}

function createIdleState() {
  return {
    status: 'IDLE',
    message: 'Chua chay quet hang loat.',
    current: 0,
    batchTotal: BATCH_SIZE,
    processedTotal: 0,
    failedTotal: 0,
    jobId: '',
    cancelRequested: false,
    sourceTabId: null,
    sourceGroupUrl: '',
    activePostUrl: '',
    activeScanTabId: null,
    lastResult: null,
    history: [],
  };
}

async function setBatchState(state) {
  await chrome.storage.local.set({
    [BATCH_STATE_KEY]: {
      ...state,
      updatedAt: new Date().toISOString(),
    },
  });
}

async function updateBatchState(patch) {
  await setBatchState({ ...(await getBatchState()), ...patch });
}

function isFacebookGroupUrl(value) {
  try {
    const url = new URL(value);
    return (
      isFacebookHostname(url.hostname) &&
      url.pathname.startsWith('/groups/')
    );
  } catch {
    return false;
  }
}

function isFacebookGroupPostUrl(value) {
  try {
    const url = new URL(value);
    return (
      isFacebookHostname(url.hostname) &&
      /\/groups\/[^/?#]+\/(?:posts|permalink)\/[^/?#]+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function getPostIdentity(value) {
  try {
    const match = new URL(value).pathname.match(
      /\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)/,
    );
    return match?.[2] || '';
  } catch {
    return '';
  }
}

function isFacebookHostname(hostname) {
  return hostname === 'facebook.com' || hostname.endsWith('.facebook.com');
}

function normalizePostUrl(value) {
  const url = new URL(value);
  const match = url.pathname.match(
    /\/groups\/([^/?#]+)\/(?:posts|permalink)\/([^/?#]+)/,
  );
  if (match) {
    url.hostname = 'www.facebook.com';
    url.pathname = `/groups/${match[1]}/posts/${match[2]}/`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'FETCH_SCANNED_POST_IDS') {
    const groupUrls = message.groupUrls || (message.groupUrl ? [message.groupUrl] : []);
    if (!groupUrls.length) {
      sendResponse({ ok: false, error: 'groupUrls is required' });
      return true;
    }

    chrome.storage.local.get([API_URL_KEY, TOKEN_KEY]).then(async (data) => {
      const apiBaseUrl = (data[API_URL_KEY] || 'http://localhost:5000/api').replace(/\/+$/, '');
      const token = data[TOKEN_KEY] || '';
      
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['x-dao-edu-scanner-token'] = token;

        // Query cho tất cả các đại diện groupUrl song song
        const promises = groupUrls.map(async (gUrl) => {
          const url = `${apiBaseUrl}/facebook-lead-scans/sync/scanned-posts?groupUrl=${encodeURIComponent(gUrl)}`;
          const res = await fetch(url, { headers });
          if (!res.ok) return { postIds: [], recentScans: [] };
          return await res.json().catch(() => ({ postIds: [], recentScans: [] }));
        });

        const results = await Promise.all(promises);
        
        // Gộp kết quả của tất cả các groupUrl
        const mergedPostIds = new Set();
        const mergedRecentScans = [];
        const seenScanUrls = new Set();

        for (const result of results) {
          if (Array.isArray(result.postIds)) {
            result.postIds.forEach(id => mergedPostIds.add(id));
          }
          if (Array.isArray(result.recentScans)) {
            result.recentScans.forEach(scan => {
              if (scan.postUrl && !seenScanUrls.has(scan.postUrl)) {
                seenScanUrls.add(scan.postUrl);
                mergedRecentScans.push(scan);
              }
            });
          }
        }

        sendResponse({
          ok: true,
          postIds: [...mergedPostIds],
          recentScans: mergedRecentScans
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });

    return true;
  }
});

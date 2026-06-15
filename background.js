const BATCH_STATE_KEY = 'daoEduLeadScannerBatchState';
const BATCH_SIZE = 10;
const POST_SCAN_TIMEOUT_MS = 45000;
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
  if (message?.type === 'START_BATCH_SCAN') {
    startBatch(message.sourceTabId)
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
    )
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }
});

async function startBatch(sourceTabId) {
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
  await setBatchState({
    status: 'RUNNING',
    message: 'Dang tim bai chua quet tren trang nhom...',
    current: 0,
    batchTotal: BATCH_SIZE,
    processedTotal: currentState.processedTotal || 0,
    failedTotal: currentState.failedTotal || 0,
    jobId,
    cancelRequested: false,
    sourceTabId,
    sourceGroupUrl: sourceTab.url,
    activePostUrl: '',
    activeScanTabId: null,
    lastResult: null,
  });

  const response = await chrome.tabs.sendMessage(sourceTabId, {
    type: 'RUN_GROUP_BATCH',
    limit: BATCH_SIZE,
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

async function scanPostInBackgroundTab(postUrl, jobId, windowId) {
  if (!isFacebookGroupPostUrl(postUrl)) {
    throw new Error('Link bai viet Facebook khong hop le.');
  }
  await assertBatchActive(jobId);

  let scanTab = null;
  try {
    scanTab = await chrome.tabs.create({
      url: normalizePostUrl(postUrl),
      active: false,
      ...(Number.isInteger(windowId) ? { windowId } : {}),
    });
    registerActiveScanTab(jobId, scanTab.id);
    await updateBatchState({
      activePostUrl: normalizePostUrl(postUrl),
      activeScanTabId: scanTab.id,
    });
    await waitForTabComplete(scanTab.id, postUrl, POST_SCAN_TIMEOUT_MS);
    await assertBatchActive(jobId);
    await ensureContentScript(scanTab.id);

    const result = await chrome.tabs.sendMessage(scanTab.id, {
      type: 'DEEP_SCAN_AND_SAVE_CURRENT_POST',
      maxRounds: 20,
      maxClicksPerRound: 40,
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

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['batch-queue.js', 'content.js'],
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
      /\/groups\/[^/]+\/(?:posts|permalink)\/\d+/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function getPostIdentity(value) {
  try {
    const match = new URL(value).pathname.match(
      /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/,
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
    /\/groups\/([^/]+)\/(?:posts|permalink)\/(\d+)/,
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

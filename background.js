const BATCH_STATE_KEY = 'daoEduLeadScannerBatchState';
const BATCH_SIZE = 10;

chrome.runtime.onInstalled.addListener(async () => {
  await setBatchState(createIdleState());
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
  await setBatchState({
    status: 'RUNNING',
    message: 'Dang tim bai chua quet tren trang nhom...',
    current: 0,
    batchTotal: BATCH_SIZE,
    processedTotal: currentState.processedTotal || 0,
    failedTotal: currentState.failedTotal || 0,
    sourceTabId,
    sourceGroupUrl: sourceTab.url,
    lastResult: null,
  });

  const response = await chrome.tabs.sendMessage(sourceTabId, {
    type: 'RUN_GROUP_BATCH',
    limit: BATCH_SIZE,
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
    files: ['content.js'],
  });
  await sleep(250);
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
    sourceTabId: null,
    sourceGroupUrl: '',
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
    return url.hostname.endsWith('facebook.com') && url.pathname.startsWith('/groups/');
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

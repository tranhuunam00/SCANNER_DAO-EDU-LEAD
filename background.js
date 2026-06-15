const BATCH_STATE_KEY = 'daoEduLeadScannerBatchState';
const SCANNED_URLS_KEY = 'daoEduLeadScannerScannedPostUrls';
const BATCH_SIZE = 10;
const MAX_SCROLL_ROUNDS = 12;
const MAX_BATCH_MILLISECONDS = 10 * 60 * 1000;

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
  if (!sourceTab.url || !isFacebookGroupFeedUrl(sourceTab.url)) {
    throw new Error('Hay mo trang danh sach bai viet cua nhom Facebook truoc.');
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

  runBatchFromBackground(sourceTabId, sourceTab.url, BATCH_SIZE).catch(
    async (error) => {
      await updateBatchState({
        status: 'ERROR',
        message: error.message || String(error),
      });
    },
  );

  return { ok: true };
}

async function runBatchFromBackground(sourceTabId, sourceGroupUrl, limit) {
  const startedAt = Date.now();
  const attempted = new Set();
  let completed = 0;
  let failed = 0;
  let scrollRounds = 0;

  while (
    attempted.size < limit &&
    scrollRounds < MAX_SCROLL_ROUNDS &&
    Date.now() - startedAt < MAX_BATCH_MILLISECONDS
  ) {
    const scannedUrls = await getScannedUrls();
    const collected = await chrome.tabs.sendMessage(sourceTabId, {
      type: 'COLLECT_POST_LINKS',
      scannedUrls: [...scannedUrls, ...attempted],
      limit: limit - attempted.size,
    });
    const urls = collected?.urls || [];

    if (!urls.length) {
      scrollRounds += 1;
      await updateBatchState({
        current: attempted.size,
        message: `Dang cuon tim bai moi (${scrollRounds}/${MAX_SCROLL_ROUNDS})...`,
      });
      await chrome.tabs.sendMessage(sourceTabId, { type: 'SCROLL_GROUP_FEED' });
      await sleep(1800);
      continue;
    }

    scrollRounds = 0;
    for (const postUrl of urls) {
      if (attempted.size >= limit) break;
      attempted.add(postUrl);
      await updateBatchState({
        current: attempted.size,
        activePostUrl: postUrl,
        message: `Dang mo permalink va quet sau bai ${attempted.size}/${limit}...`,
      });

      let postTabId = null;
      try {
        const postTab = await chrome.tabs.create({ url: postUrl, active: true });
        postTabId = postTab.id;
        await waitForTabComplete(postTabId, postUrl);
        await ensureContentScript(postTabId);
        const result = await chrome.tabs.sendMessage(postTabId, {
          type: 'DEEP_SCAN_AND_SAVE_CURRENT_POST',
          maxRounds: 20,
          maxClicksPerRound: 40,
        });
        if (!result?.ok) {
          throw new Error(result?.error || 'Khong quet duoc permalink.');
        }

        completed += 1;
        await updateBatchState({
          current: attempted.size,
          processedTotal: await incrementBatchCounter('processedTotal'),
          lastResult: {
            postUrl,
            posts: result.summary.posts,
            comments: result.summary.comments,
            clickedExpanders: result.summary.clickedExpanders,
          },
          message: `Da quet xong bai ${attempted.size}/${limit}: ${result.summary.comments} binh luan.`,
        });
      } catch (error) {
        failed += 1;
        await updateBatchState({
          current: attempted.size,
          failedTotal: await incrementBatchCounter('failedTotal'),
          lastResult: { postUrl, error: error.message || String(error) },
          message: `Bai ${attempted.size}/${limit} loi: ${error.message || String(error)}`,
        });
      } finally {
        if (postTabId) await chrome.tabs.remove(postTabId).catch(() => {});
      }
    }
  }

  const reachedLimit = attempted.size >= limit;
  await updateBatchState({
    status: reachedLimit ? 'AWAITING_CONTINUE' : 'DONE',
    current: attempted.size,
    activePostUrl: null,
    sourceGroupUrl,
    message: reachedLimit
      ? `Da xu ly ${attempted.size} bai, thanh cong ${completed}, loi ${failed}.`
      : `Da dung sau ${scrollRounds} lan cuon: thanh cong ${completed}, loi ${failed}.`,
  });
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

async function getScannedUrls() {
  const data = await chrome.storage.local.get(SCANNED_URLS_KEY);
  return new Set(data[SCANNED_URLS_KEY] || []);
}

async function incrementBatchCounter(key) {
  const state = await getBatchState();
  return Number(state[key] || 0) + 1;
}

async function waitForTabComplete(tabId, expectedUrl) {
  const expectedId = getPostIdentity(expectedUrl);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 25000) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && getPostIdentity(tab.url) === expectedId) {
      await sleep(800);
      return;
    }
    await sleep(250);
  }
  throw new Error('Facebook tai permalink qua lau.');
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

function isFacebookGroupFeedUrl(value) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split('/').filter(Boolean);
    return (
      url.hostname.endsWith('facebook.com') &&
      parts[0] === 'groups' &&
      parts.length === 2
    );
  } catch {
    return false;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

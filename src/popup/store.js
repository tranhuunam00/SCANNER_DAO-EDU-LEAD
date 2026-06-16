import { create } from 'zustand';

const STORAGE_KEY = 'daoEduLeadScannerItems';
const META_KEY = 'daoEduLeadScannerMeta';
const BATCH_STATE_KEY = 'daoEduLeadScannerBatchState';
const BATCH_CONFIG_KEY = 'daoEduLeadScannerBatchConfig';
const API_URL_KEY = 'daoEduLeadScannerApiBaseUrl';
const TOKEN_KEY = 'daoEduLeadScannerToken';

const DEFAULT_BATCH_STATE = {
  status: 'IDLE',
  current: 0,
  batchTotal: 0,
  processedTotal: 0,
  history: [],
  message: '',
  activePostUrl: null,
};

export const useStore = create((set, get) => ({
  items: [],
  meta: null,
  batchState: { ...DEFAULT_BATCH_STATE },
  batchConfig: { limit: 10, postTimeoutSec: 120, totalTimeoutMin: 30, ignoreScanned: true },
  apiBaseUrl: 'http://localhost:5000/api',
  token: '',
  statusMsg: 'Sẵn sàng.',
  statusError: false,
  syncMessage: '',
  syncError: false,
  syncState: 'Chưa đồng bộ',
  busy: false,
  logs: [],

  setStatus: (msg, isError = false) => set({ statusMsg: msg, statusError: isError }),
  setSyncMessage: (msg, isError = false) => set({ syncMessage: msg, syncError: isError }),
  setBusy: (busy) => set({ busy }),

  exportJson: async () => {
    const { items, batchState, meta } = get();
    const payload = {
      exportedAt: new Date().toISOString(),
      meta,
      items,
      batchHistory: Array.isArray(batchState.history) ? batchState.history : [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await chrome.downloads.download({ url, filename: `dao-edu-scanner-raw-${ts}.json`, saveAs: false });
    URL.revokeObjectURL(url);
  },

  init: async () => {
    const data = await chrome.storage.local.get([
      STORAGE_KEY, META_KEY, BATCH_STATE_KEY, BATCH_CONFIG_KEY, API_URL_KEY, TOKEN_KEY
    ]);
    const storedItems = data[STORAGE_KEY];
    const storedBatch = data[BATCH_STATE_KEY];
    set({
      items: Array.isArray(storedItems) ? storedItems : [],
      meta: data[META_KEY] || null,
      batchState: storedBatch && typeof storedBatch === 'object'
        ? { ...DEFAULT_BATCH_STATE, ...storedBatch, history: Array.isArray(storedBatch.history) ? storedBatch.history : [] }
        : { ...DEFAULT_BATCH_STATE },
      batchConfig: data[BATCH_CONFIG_KEY] || { limit: 10, postTimeoutSec: 120, totalTimeoutMin: 30, ignoreScanned: true },
      apiBaseUrl: data[API_URL_KEY] || 'http://localhost:5000/api',
      token: data[TOKEN_KEY] || '',
    });
    // load batch state from background
    get().loadBatchState();
  },

  saveBatchConfig: (config) => {
    set({ batchConfig: config });
    chrome.storage.local.set({ [BATCH_CONFIG_KEY]: config });
  },

  saveApiUrl: (url) => {
    set({ apiBaseUrl: url });
    chrome.storage.local.set({ [API_URL_KEY]: url });
  },

  loadBatchState: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
      if (!response?.ok) return;
      const s = response.state || {};
      set({
        batchState: {
          ...DEFAULT_BATCH_STATE,
          ...s,
          history: Array.isArray(s.history) ? s.history : [],
        }
      });
    } catch { /* background not ready */ }
  },

  startBatch: async (continueBatch = false) => {
    const { batchConfig } = get();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Không tìm thấy tab đang mở.');
      const response = await chrome.runtime.sendMessage({
        type: 'START_GROUP_BATCH',
        sourceTabId: tab.id,
        continueBatch,
        config: batchConfig,
      });
      if (!response?.ok) throw new Error(response?.error || 'Không thể bắt đầu quét hàng loạt.');
      get().loadBatchState();
    } catch (e) {
      set({ statusMsg: e.message, statusError: true });
    }
  },

  stopBatch: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'STOP_BATCH_SCAN' });
      if (!response?.ok) throw new Error(response?.error || 'Không thể dừng job nền.');
      get().loadBatchState();
      set({ statusMsg: 'Đã dừng và xóa job nền.', statusError: false });
    } catch (e) {
      set({ statusMsg: e.message, statusError: true });
    }
  },

  forceStop: async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'STOP_BATCH_SCAN' });
      await chrome.storage.local.remove([STORAGE_KEY, META_KEY, BATCH_STATE_KEY]);
      set({
        items: [],
        meta: null,
        batchState: { ...DEFAULT_BATCH_STATE },
        statusMsg: 'Đã dừng và xóa toàn bộ.',
        statusError: false,
        syncMessage: '',
        syncState: 'Chưa đồng bộ',
      });
    } catch (e) {
      set({ statusMsg: e.message, statusError: true });
    }
  },

  addLog: (msg) => set(state => ({ logs: [...state.logs.slice(-49), `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`] })),

  scanSinglePost: async (postUrl) => {
    const { addLog } = get();
    set({ busy: true, statusMsg: 'Đang quét sâu toàn bộ bình luận...', statusError: false });
    addLog('Bắt đầu quét sâu bài viết...');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Không tìm thấy tab đang mở.');
      addLog(`Tab hiện tại: ${tab.url}`);

      // Nếu có link dán vào thì điều hướng tab đó đến link trước
      if (postUrl) {
        addLog(`Mở link: ${postUrl}`);
        await chrome.tabs.update(tab.id, { url: postUrl });
        // Chờ tab load xong
        await new Promise(resolve => setTimeout(resolve, 3000));
        addLog('Tab đã load xong, tiếp tục quét...');
      }

      // Đảm bảo content script đã được inject
      addLog('Kiểm tra content script...');
      try {
        const ping = await chrome.tabs.sendMessage(tab.id, { type: 'PING_SCANNER' });
        addLog(`PING: ${ping?.ok ? 'OK' : 'Không phản hồi, sẽ inject lại'}`);
        if (!ping?.ok) throw new Error('need inject');
      } catch {
        addLog('Inject content script...');
        const manifest = chrome.runtime.getManifest();
        const scripts = manifest.content_scripts?.[0]?.js || ['assets/batch-queue.js', 'assets/content.js'];
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: scripts });
        await new Promise(resolve => setTimeout(resolve, 300));
        addLog('Đã inject content script xong.');
      }

      // Gửi lệnh quét sâu THẲNG vào content script của tab - KHÔNG qua background
      addLog('Gửi lệnh DEEP_SCAN_CURRENT_POST...');
      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'DEEP_SCAN_CURRENT_POST',
        maxRounds: 20,
        maxClicksPerRound: 40,
      });

      addLog(`Kết quả: ok=${result?.ok}, posts=${result?.summary?.posts}, comments=${result?.summary?.comments}`);

      if (!result?.ok) throw new Error(result?.error || 'Không đọc được nội dung Facebook.');

      // Merge và lưu vào storage
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const existing = stored[STORAGE_KEY] || [];
      const retained = existing.filter(item => item.pageUrl !== result.summary.postUrl);
      
      // Merge items
      const map = new Map(retained.map(i => [i.fingerprint, i]));
      for (const item of (result.items || [])) {
        map.set(item.fingerprint, { ...map.get(item.fingerprint), ...item, lastSeenAt: new Date().toISOString() });
      }
      const merged = [...map.values()].sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));

      const meta = {
        scannedAt: new Date().toISOString(),
        pageUrl: tab.url,
        lastPostCount: result.summary.posts,
        lastCommentCount: result.summary.comments,
        postUrl: result.summary.postUrl,
      };

      await chrome.storage.local.set({ [STORAGE_KEY]: merged, [META_KEY]: meta });

      const note = result.summary.postDetected ? '' : ' Không thấy nội dung bài gốc.';
      const msg = `Đã quét ${result.summary.posts} bài và ${result.summary.comments} bình luận.${note}`;
      set({ statusMsg: msg, statusError: false });
      addLog(msg);
    } catch (e) {
      addLog(`Lỗi: ${e.message}`);
      set({ statusMsg: e.message, statusError: true });
    } finally {
      set({ busy: false });
    }
  },

  syncToBackend: async () => {
    const { items, apiBaseUrl, token } = get();
    if (!items.length) return;
    if (!token) {
      set({ syncMessage: 'Bạn chưa nhập Token kết nối API!', syncError: true });
      return;
    }
    set({ syncMessage: 'Đang đồng bộ...', syncError: false });
    try {
      const base = (apiBaseUrl || 'http://localhost:5000/api').replace(/\/+$/, '');
      const res = await fetch(`${base}/facebook-lead-scans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-dao-edu-scanner-token': token },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `API lỗi: ${res.status}`);
      }
      const data = await res.json();
      await chrome.storage.local.set({ [STORAGE_KEY]: [] });
      set({ items: [], meta: null, syncState: 'Đã đồng bộ', syncMessage: `Thành công! Đã đồng bộ ${data.data?.itemCount || 0} mục lên BE.`, syncError: false });
      // pull scanned from BE
      get().pullTemFromBackend();
    } catch (e) {
      set({ syncMessage: `Đồng bộ thất bại: ${e.message}`, syncError: true });
    }
  },

  pullTemFromBackend: async () => {
    set({ syncMessage: 'Đang xóa cache và tải lại từ BE...', syncError: false });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Không tìm thấy tab Facebook đang mở.');

      // Bước 1: Xóa TOÀN BỘ cache cục bộ
      await chrome.storage.local.remove([
        STORAGE_KEY,
        META_KEY,
        BATCH_STATE_KEY,
        'daoEduLeadScannerScannedPostUrls',
        'daoEduLeadScannerAttemptedPostUrls',
        'daoEduLeadScannerLeadAnalysis',
      ]);

      // Cập nhật state React về trạng thái sạch
      useStore.setState({
        items: [],
        meta: null,
        batchState: {
          status: 'IDLE', current: 0, batchTotal: 0,
          processedTotal: 0, history: [], message: ''
        },
        syncState: 'Đã xóa cache',
      });

      // Bước 2: Kéo lại từ BE
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_SYNC_SCANNED_POSTS' });
      if (res?.ok) {
        set({ syncMessage: `Xóa cache và tải về ${res.count || 0} bài thành công!`, syncError: false, syncState: 'Đã đồng bộ' });
        get().loadBatchState();
      } else {
        throw new Error(res?.error || 'Không tải được tem từ BE.');
      }
    } catch (e) {
      set({ syncMessage: `Thất bại: ${e.message}`, syncError: true });
    }
  },
}));

// Reactive: lắng nghe chrome.storage.onChanged để cập nhật React tự động
chrome.storage.onChanged.addListener((changes, ns) => {
  if (ns !== 'local') return;
  const updates = {};
  if (changes[STORAGE_KEY]) {
    const val = changes[STORAGE_KEY].newValue;
    updates.items = Array.isArray(val) ? val : [];
  }
  if (changes[META_KEY]) updates.meta = changes[META_KEY].newValue || null;
  if (changes[BATCH_STATE_KEY]) {
    const val = changes[BATCH_STATE_KEY].newValue;
    updates.batchState = val && typeof val === 'object'
      ? { ...DEFAULT_BATCH_STATE, ...val, history: Array.isArray(val.history) ? val.history : [] }
      : { ...DEFAULT_BATCH_STATE };
  }
  if (Object.keys(updates).length) useStore.setState(updates);
});

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

  setStatus: (msg, isError = false) => set({ statusMsg: msg, statusError: isError }),
  setSyncMessage: (msg, isError = false) => set({ syncMessage: msg, syncError: isError }),
  setBusy: (busy) => set({ busy }),

  init: async () => {
    const data = await chrome.storage.local.get([
      STORAGE_KEY, META_KEY, BATCH_STATE_KEY, BATCH_CONFIG_KEY, API_URL_KEY, TOKEN_KEY
    ]);
    set({
      items: data[STORAGE_KEY] || [],
      meta: data[META_KEY] || null,
      batchState: data[BATCH_STATE_KEY] || { ...DEFAULT_BATCH_STATE },
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
    const response = await chrome.runtime.sendMessage({ type: 'GET_BATCH_STATE' });
    if (!response?.ok) return;
    set({ batchState: response.state || { ...DEFAULT_BATCH_STATE } });
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

  scanSinglePost: async (postUrl) => {
    set({ busy: true, statusMsg: 'Đang quét...', statusError: false });
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Không tìm thấy tab.');
      const result = await chrome.runtime.sendMessage({
        type: 'SCAN_POST_IN_BACKGROUND_TAB',
        postUrl: postUrl || tab.url,
        config: { postTimeoutMs: 15000 },
      });
      if (!result?.ok) throw new Error(result?.error || 'Quét thất bại.');
      const note = result.summary.postDetected ? '' : ' Không thấy nội dung chữ của bài gốc nên đã lưu post rỗng.';
      set({ statusMsg: `Đã quét ${result.summary.posts} bài và ${result.summary.comments} bình luận.${note}` });
    } catch (e) {
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
  if (changes[STORAGE_KEY]) updates.items = changes[STORAGE_KEY].newValue || [];
  if (changes[META_KEY]) updates.meta = changes[META_KEY].newValue || null;
  if (changes[BATCH_STATE_KEY]) updates.batchState = changes[BATCH_STATE_KEY].newValue || { ...DEFAULT_BATCH_STATE };
  if (Object.keys(updates).length) useStore.setState(updates);
});

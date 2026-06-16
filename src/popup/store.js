import { create } from 'zustand';
import {
  STORAGE_KEY,
  META_KEY,
  BATCH_STATE_KEY,
  BATCH_CONFIG_KEY,
  API_URL_KEY,
  TOKEN_KEY,
  SCANNED_URLS_KEY,
  BATCH_ATTEMPTED_URLS_KEY,
  LEAD_ANALYSIS_KEY,
  DEFAULT_API_URL,
  DEFAULT_POST_TIMEOUT_SEC,
  DEFAULT_TOTAL_TIMEOUT_MIN,
} from '../constants';

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
  batchConfig: { limit: 10, postTimeoutSec: DEFAULT_POST_TIMEOUT_SEC, totalTimeoutMin: DEFAULT_TOTAL_TIMEOUT_MIN, ignoreScanned: true },
  apiBaseUrl: DEFAULT_API_URL,
  token: '',
  statusMsg: 'Sẵn sàng.',
  statusError: false,
  syncMessage: '',
  syncError: false,
  syncState: 'Chưa đồng bộ',
  busy: false,
  logs: [],
  scannedPostUrls: [],
  initialScannedUrls: [],
  batchAttemptedPostUrls: [],

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
      STORAGE_KEY, META_KEY, BATCH_STATE_KEY, BATCH_CONFIG_KEY, API_URL_KEY, TOKEN_KEY,
      SCANNED_URLS_KEY, BATCH_ATTEMPTED_URLS_KEY
    ]);
    const storedItems = data[STORAGE_KEY];
    const storedBatch = data[BATCH_STATE_KEY];
    set({
      items: Array.isArray(storedItems) ? storedItems : [],
      meta: data[META_KEY] || null,
      batchState: storedBatch && typeof storedBatch === 'object'
        ? { ...DEFAULT_BATCH_STATE, ...storedBatch, history: Array.isArray(storedBatch.history) ? storedBatch.history : [] }
        : { ...DEFAULT_BATCH_STATE },
      batchConfig: {
        limit: 10,
        postTimeoutSec: DEFAULT_POST_TIMEOUT_SEC,
        totalTimeoutMin: DEFAULT_TOTAL_TIMEOUT_MIN,
        ignoreScanned: true,
        ...(data[BATCH_CONFIG_KEY] || {})
      },
      apiBaseUrl: data[API_URL_KEY] || DEFAULT_API_URL,
      token: data[TOKEN_KEY] || '',
      scannedPostUrls: Array.isArray(data[SCANNED_URLS_KEY]) ? data[SCANNED_URLS_KEY] : [],
      initialScannedUrls: Array.isArray(data[SCANNED_URLS_KEY]) ? data[SCANNED_URLS_KEY] : [],
      batchAttemptedPostUrls: Array.isArray(data[BATCH_ATTEMPTED_URLS_KEY]) ? data[BATCH_ATTEMPTED_URLS_KEY] : [],
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

  addLog: (msg) => set(state => ({ logs: [...state.logs.slice(-199), `[${new Date().toLocaleTimeString('vi-VN')}] ${msg}`] })),

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
      
      // Merge items (keep old ones, including from current post, updating by fingerprint)
      const map = new Map(existing.map(i => [i.fingerprint, i]));
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

      // Cập nhật danh sách bài đã quét để tránh quét trùng lặp khi chạy hàng loạt (ignoreScanned)
      if (result.summary.postUrl) {
        const scannedUrlsData = await chrome.storage.local.get(SCANNED_URLS_KEY);
        const scannedUrls = new Set(scannedUrlsData[SCANNED_URLS_KEY] || []);
        scannedUrls.add(result.summary.postUrl);
        await chrome.storage.local.set({ [SCANNED_URLS_KEY]: [...scannedUrls] });
      }

      // Cập nhật hiển thị lịch sử quét trên popup (batchState.history)
      if (result.summary.postUrl) {
        const batchData = await chrome.storage.local.get(BATCH_STATE_KEY);
        const batchState = batchData[BATCH_STATE_KEY] || { ...DEFAULT_BATCH_STATE };
        const currentHistory = Array.isArray(batchState.history) ? batchState.history : [];
        
        // Loại bỏ trùng lặp và unshift bản ghi mới nhất lên đầu danh sách
        const filteredHistory = currentHistory.filter(item => item.postUrl !== result.summary.postUrl);
        filteredHistory.unshift({
          postUrl: result.summary.postUrl,
          comments: result.summary.comments,
          status: 'SUCCESS',
        });
        
        batchState.history = filteredHistory;
        batchState.processedTotal = filteredHistory.filter(item => item.status === 'SUCCESS').length;
        
        await chrome.storage.local.set({ [BATCH_STATE_KEY]: batchState });
      }

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
    const { items, apiBaseUrl, token, addLog } = get();
    if (!items.length) return;
    
    addLog('Bắt đầu đồng bộ dữ liệu lên Backend...');
    set({ syncMessage: 'Đang đồng bộ...', syncError: false });
    try {
      const base = (apiBaseUrl || DEFAULT_API_URL).replace(/\/+$/, '');
      const headers = { 'Content-Type': 'application/json' };
      if (token) {
        headers['x-dao-edu-scanner-token'] = token;
      }
      
      const res = await fetch(`${base}/facebook-lead-scans`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ items }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `API lỗi: ${res.status}`);
      }
      const data = await res.json();
      await chrome.storage.local.set({ [STORAGE_KEY]: [] });
      const successMsg = `Thành công! Đã đồng bộ ${data.data?.itemCount || 0} mục lên BE.`;
      set({ items: [], meta: null, syncState: 'Đã đồng bộ', syncMessage: successMsg, syncError: false });
      addLog(successMsg);
      // pull scanned from BE (silent if not on a Facebook tab)
      get().pullTemFromBackend(true);
    } catch (e) {
      const errMsg = `Đồng bộ thất bại: ${e.message}`;
      set({ syncMessage: errMsg, syncError: true });
      addLog(errMsg);
    }
  },

  pullTemFromBackend: async (silentIfNoTab = false) => {
    const { items, addLog } = get();
    if (items.length > 0) {
      const ok = window.confirm(
        'Bạn đang có dữ liệu cào mới chưa đồng bộ lên Backend. Việc xóa cache và tải lại từ BE sẽ xóa sạch dữ liệu này. Bạn có chắc chắn muốn tiếp tục không?'
      );
      if (!ok) {
        set({ syncMessage: 'Đã hủy thao tác xóa cache.', syncError: false });
        return;
      }
    }
    
    if (silentIfNoTab) {
      addLog('Đang đồng bộ lại danh sách bài viết đã quét từ BE...');
    } else {
      addLog('Bắt đầu xóa cache và tải lại dữ liệu từ BE...');
      set({ syncMessage: 'Đang xóa cache và tải lại từ BE...', syncError: false });
    }
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        throw new Error('Không tìm thấy tab Facebook đang mở.');
      }

      const isFb = tab.url && (tab.url.includes('facebook.com') || tab.url.includes('fb.com'));
      if (!isFb) {
        throw new Error('Tab hiện tại không phải Facebook. Vui lòng chuyển sang tab Facebook để tải lại dữ liệu.');
      }

      // Bước 1: Xóa TOÀN BỘ cache cục bộ
      await chrome.storage.local.remove([
        STORAGE_KEY,
        META_KEY,
        BATCH_STATE_KEY,
        SCANNED_URLS_KEY,
        BATCH_ATTEMPTED_URLS_KEY,
        LEAD_ANALYSIS_KEY,
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
      let res;
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_SYNC_SCANNED_POSTS' });
      } catch (err) {
        addLog('Không kết nối được content script. Đang tự động inject lại...');
        try {
          const manifest = chrome.runtime.getManifest();
          const scripts = manifest.content_scripts?.[0]?.js || ['assets/batch-queue.js', 'assets/content.js'];
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: scripts });
          await new Promise(resolve => setTimeout(resolve, 500));
          res = await chrome.tabs.sendMessage(tab.id, { type: 'FORCE_SYNC_SCANNED_POSTS' });
        } catch (injectErr) {
          throw new Error('Không thể kết nối tới trang Facebook. Vui lòng tải lại trang (F5) Facebook và thử lại.');
        }
      }

      if (res?.ok) {
        const msg = `Xóa cache và tải về ${res.count || 0} bài thành công!`;
        const updatedData = await chrome.storage.local.get(SCANNED_URLS_KEY);
        const updatedScanned = updatedData[SCANNED_URLS_KEY] || [];
        set({
          syncMessage: msg,
          syncError: false,
          syncState: 'Đã đồng bộ',
          initialScannedUrls: Array.isArray(updatedScanned) ? updatedScanned : [],
        });
        addLog(msg);
        get().loadBatchState();
      } else {
        throw new Error(res?.error || 'Không tải được tem từ BE.');
      }
    } catch (e) {
      if (silentIfNoTab) {
        addLog(`[Cảnh báo] Không thể đồng bộ lại danh sách bài viết từ BE: ${e.message}`);
      } else {
        const errMsg = `Tải lại từ BE thất bại: ${e.message}`;
        set({ syncMessage: errMsg, syncError: true });
        addLog(errMsg);
      }
    }
  },

  rescanFailedPosts: async () => {
    const { batchAttemptedPostUrls, scannedPostUrls } = get();
    
    const getPostIdLocal = (url) => {
      try {
        const u = new URL(url);
        const m = u.pathname.match(/\/posts\/([^/]+)/) || u.pathname.match(/\/permalink\/([^/]+)/);
        if (m) return m[1];
        const parts = u.pathname.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : url;
      } catch {
        const m = String(url).match(/\/posts\/([^/?#]+)/) || String(url).match(/\/permalink\/([^/?#]+)/);
        return m ? m[1] : String(url).split('/').filter(Boolean).pop() || url;
      }
    };
    
    const scannedIds = new Set(scannedPostUrls.map(u => getPostIdLocal(u)));
    const failedUrls = batchAttemptedPostUrls.filter(url => !scannedIds.has(getPostIdLocal(url)));
    
    if (failedUrls.length === 0) {
      set({ statusMsg: 'Không có bài viết nào bị lỗi để quét lại.', statusError: false });
      return;
    }
    
    // Remove failed URLs from the attempted list in local storage
    const nextAttempted = batchAttemptedPostUrls.filter(url => !failedUrls.includes(url));
    await chrome.storage.local.set({ [BATCH_ATTEMPTED_URLS_KEY]: nextAttempted });
    
    // Also remove them from batchState.history
    const data = await chrome.storage.local.get(BATCH_STATE_KEY);
    const batchState = data[BATCH_STATE_KEY] || {};
    if (Array.isArray(batchState.history)) {
      batchState.history = batchState.history.filter(h => !failedUrls.some(fu => getPostIdLocal(fu) === getPostIdLocal(h.postUrl)));
      await chrome.storage.local.set({ [BATCH_STATE_KEY]: batchState });
    }
    
    set({ statusMsg: `Đã đưa ${failedUrls.length} bài viết lỗi trở lại hàng chờ. Hãy nhấn 'Quét tiếp phần còn lại' để chạy.`, statusError: false });
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
  if (changes[BATCH_CONFIG_KEY]) {
    const val = changes[BATCH_CONFIG_KEY].newValue;
    updates.batchConfig = val && typeof val === 'object'
      ? { limit: 10, postTimeoutSec: DEFAULT_POST_TIMEOUT_SEC, totalTimeoutMin: DEFAULT_TOTAL_TIMEOUT_MIN, ignoreScanned: true, ...val }
      : { limit: 10, postTimeoutSec: DEFAULT_POST_TIMEOUT_SEC, totalTimeoutMin: DEFAULT_TOTAL_TIMEOUT_MIN, ignoreScanned: true };
  }
  if (changes[SCANNED_URLS_KEY]) {
    const val = changes[SCANNED_URLS_KEY].newValue;
    updates.scannedPostUrls = Array.isArray(val) ? val : [];
  }
  if (changes[BATCH_ATTEMPTED_URLS_KEY]) {
    const val = changes[BATCH_ATTEMPTED_URLS_KEY].newValue;
    updates.batchAttemptedPostUrls = Array.isArray(val) ? val : [];
  }
  if (Object.keys(updates).length) useStore.setState(updates);
});

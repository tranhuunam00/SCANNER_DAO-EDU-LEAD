import React, { useEffect } from 'react';
import { useStore } from './store';

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortenPostUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/posts\/([^/]+)/) || u.pathname.match(/\/permalink\/([^/]+)/);
    if (m) return `Bài viết #${m[1].slice(0, 10)}`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? `Bài viết #${parts[parts.length - 1]}` : url;
  } catch {
    return url;
  }
}

function HeaderStats() {
  const items = useStore(s => s.items);
  const batchState = useStore(s => s.batchState);

  let postCount = 0, commentCount = 0, savedCount = 0;
  if (items && items.length > 0) {
    postCount = items.filter(i => i.kind === 'POST').length;
    commentCount = items.filter(i => i.kind === 'COMMENT').length;
    savedCount = items.length;
  } else if (batchState.history && batchState.history.length > 0) {
    postCount = batchState.history.length;
    commentCount = batchState.history.reduce((s, i) => s + (Number(i.comments) || 0), 0);
    savedCount = postCount;
  }

  return (
    <section className="stats">
      <article><strong id="postCount">{postCount}</strong><span>Bài viết</span></article>
      <article><strong id="commentCount">{commentCount}</strong><span>Bình luận</span></article>
      <article><strong id="savedCount">{savedCount}</strong><span>Đã lưu</span></article>
    </section>
  );
}

function BatchPanel() {
  const batchState = useStore(s => s.batchState);
  const stopBatch = useStore(s => s.stopBatch);

  const { status, current, batchTotal, message, history } = batchState;
  const hasHistory = history && history.length > 0;
  const visible = status !== 'IDLE' || hasHistory;
  if (!visible) return null;

  const isRunning = status === 'RUNNING';
  const isAwaiting = status === 'AWAITING_CONTINUE';
  const isIdle = status === 'IDLE';

  let statusLabel = '';
  if (isIdle && hasHistory) statusLabel = 'Lịch sử từ BE';
  else if (isRunning) statusLabel = `${current}/${batchTotal}`;
  else if (isAwaiting) statusLabel = 'Chờ tiếp tục';
  else if (status === 'CANCELLED') statusLabel = 'Đã dừng';
  else if (status === 'ERROR') statusLabel = 'Lỗi';
  else statusLabel = 'Hoàn tất';

  const pct = batchTotal ? Math.round((current / batchTotal) * 100) : 0;
  const showProgress = !(isIdle && hasHistory);

  return (
    <section id="batchPanel" className="batch-panel">
      <div className="batch-heading">
        <strong>Quét hàng loạt</strong>
        <span id="batchStatus">{statusLabel}</span>
      </div>
      {showProgress && (
        <div className="progress">
          <span id="batchProgress" style={{ width: `${pct}%` }}></span>
        </div>
      )}
      <p id="batchMessage">{isIdle && hasHistory ? 'Danh sách bài quét gần nhất:' : (message || '')}</p>

      {hasHistory && (
        <div className="batch-history" id="batchHistory">
          {history.map((item, i) => {
            const isSuccess = item.status === 'SUCCESS';
            const color = isSuccess ? '#16a34a' : '#ef4444';
            const statusText = isSuccess
              ? `${item.comments} bình luận`
              : `Lỗi: ${item.error || 'không xác định'}`;
            const shortUrl = shortenPostUrl(item.postUrl || '');
            return (
              <div key={i} className="batch-history-item">
                <a className="batch-history-link" href={item.postUrl || '#'} target="_blank" rel="noopener noreferrer" title={item.postUrl}>
                  {shortUrl}
                </a>
                <span className="batch-history-count" style={{ color }}>{statusText}</span>
              </div>
            );
          })}
        </div>
      )}

      {isRunning && (
        <button id="stopBatch" className="batch-stop" onClick={stopBatch}>
          Dừng và xóa job nền
        </button>
      )}
    </section>
  );
}

function ScanActions() {
  const batchConfig = useStore(s => s.batchConfig);
  const saveBatchConfig = useStore(s => s.saveBatchConfig);
  const startBatch = useStore(s => s.startBatch);
  const busy = useStore(s => s.busy);
  const scanSinglePost = useStore(s => s.scanSinglePost);
  const batchState = useStore(s => s.batchState);
  const postUrlRef = React.useRef(null);

  const isRunning = batchState.status === 'RUNNING';
  const isAwaiting = batchState.status === 'AWAITING_CONTINUE';

  const handleScan = () => {
    const url = postUrlRef.current?.value?.trim() || '';
    scanSinglePost(url);
  };

  const updateConfig = (key, val) => {
    const next = { ...batchConfig, [key]: val };
    saveBatchConfig(next);
  };

  return (
    <div className="actions">
      <input id="postUrl" type="url" ref={postUrlRef} placeholder="Dán link bài viết Facebook..." autoComplete="off" />
      <button id="scan" className="primary" disabled={busy} onClick={handleScan}>
        Quét sâu bài viết đang mở
      </button>

      <div className="batch-settings">
        <label>
          <span>Số bài viết cần quét:</span>
          <input type="number" id="batchCount" min="1" max="500"
            value={batchConfig.limit}
            onChange={e => updateConfig('limit', parseInt(e.target.value) || 10)} />
        </label>
        <label>
          <span>Giới hạn mỗi bài (giây):</span>
          <input type="number" id="batchPostTime" min="10"
            value={batchConfig.postTimeoutSec}
            onChange={e => updateConfig('postTimeoutSec', parseInt(e.target.value) || 120)} />
        </label>
        <label>
          <span>Tổng thời gian quét (phút):</span>
          <input type="number" id="batchTotalTime" min="1"
            value={batchConfig.totalTimeoutMin}
            onChange={e => updateConfig('totalTimeoutMin', parseInt(e.target.value) || 30)} />
        </label>
        <label className="checkbox-label">
          <input type="checkbox" id="batchIgnoreScanned"
            checked={batchConfig.ignoreScanned}
            onChange={e => updateConfig('ignoreScanned', e.target.checked)} />
          <span>Chỉ quét bài mới (Bỏ qua bài đã dán tem)</span>
        </label>
      </div>

      {!isRunning && (
        <button id="batch" className="batch" onClick={() => startBatch(false)}>
          Bắt đầu Quét hàng loạt
        </button>
      )}
      {isAwaiting && (
        <button id="continueBatch" className="batch" onClick={() => startBatch(true)}>
          Quét tiếp phần còn lại
        </button>
      )}
    </div>
  );
}

function SyncPanel() {
  const apiBaseUrl = useStore(s => s.apiBaseUrl);
  const saveApiUrl = useStore(s => s.saveApiUrl);
  const syncToBackend = useStore(s => s.syncToBackend);
  const pullTemFromBackend = useStore(s => s.pullTemFromBackend);
  const syncMessage = useStore(s => s.syncMessage);
  const syncError = useStore(s => s.syncError);
  const syncState = useStore(s => s.syncState);

  return (
    <section className="sync-panel">
      <div className="section-title">
        <h2>Đồng bộ BE</h2>
        <span id="syncState">{syncState}</span>
      </div>
      <div className="sync-fields">
        <input id="apiBaseUrl" type="url" placeholder="http://localhost:5000/api"
          value={apiBaseUrl}
          onChange={e => saveApiUrl(e.target.value)}
          autoComplete="off" />
      </div>
      <button id="syncBackend" className="sync-button" onClick={syncToBackend}>
        Đồng bộ Data lên BE &amp; Xóa local
      </button>
      <button id="forceSyncTem" className="sync-button"
        style={{ marginTop: '8px', backgroundColor: '#2563eb', color: '#ffffff', border: 'none', fontWeight: 'bold' }}
        onClick={pullTemFromBackend}>
        🗑️ Xóa cache &amp; Kéo lại từ BE
      </button>
      <p id="syncMessage" className={`sync-message${syncError ? ' error' : ''}`}>{syncMessage}</p>
    </section>
  );
}

function PreviewSection() {
  const items = useStore(s => s.items);
  const meta = useStore(s => s.meta);

  return (
    <section>
      <div className="section-title">
        <h2>Dữ liệu gần nhất</h2>
        <span id="scanTime">{meta?.scannedAt ? new Date(meta.scannedAt).toLocaleString('vi-VN') : ''}</span>
      </div>
      <div id="preview" className="preview">
        {!items.length ? (
          <div className="empty">Chưa có dữ liệu.</div>
        ) : (
          items.map((item, i) => (
            <div key={item.fingerprint || i} className="item">
              <div className="item-top">
                <a className="author-link" href={item.authorUrl || '#'} target="_blank" rel="noopener noreferrer">
                  {item.authorName || '(Ẩn danh)'}
                </a>
                <span className="tag">{item.kind === 'POST' ? 'Bài viết' : 'Bình luận'}</span>
              </div>
              <p>{item.body || ''}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function DebugLog() {
  const batchState = useStore(s => s.batchState);
  const statusMsg = useStore(s => s.statusMsg);
  const syncMessage = useStore(s => s.syncMessage);
  const logs = [];
  if (statusMsg && statusMsg !== 'Sẵn sàng.') logs.push(statusMsg);
  if (syncMessage) logs.push(syncMessage);
  if (batchState.message) logs.push(batchState.message);

  return (
    <div className="panel">
      <h3 className="panel-header">Console Log</h3>
      <div id="debugLog" style={{ height: '120px', overflowY: 'auto', background: '#f0f2f5', padding: '8px', fontFamily: 'monospace', fontSize: '11px', borderRadius: '4px' }}>
        {logs.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}

export default function App() {
  const init = useStore(s => s.init);
  const statusMsg = useStore(s => s.statusMsg);
  const statusError = useStore(s => s.statusError);
  const forceStop = useStore(s => s.forceStop);
  const loadBatchState = useStore(s => s.loadBatchState);

  useEffect(() => {
    init();
    // Poll batch state mỗi 1.5s khi đang chạy
    const interval = setInterval(loadBatchState, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <main>
      <header>
        <div className="logo">D</div>
        <div>
          <h1>DAO EDU Scanner</h1>
          <p>Thử nghiệm quét Facebook</p>
        </div>
      </header>

      <section className="notice">
        Dán link bài Facebook hoặc để trống để quét sâu bài đang mở.
      </section>

      <ScanActions />
      <BatchPanel />
      <HeaderStats />
      <p id="status" className={`status${statusError ? ' error' : ''}`}>{statusMsg}</p>
      <SyncPanel />
      <PreviewSection />

      <footer>
        <button id="forceStop" className="danger clear-all" onClick={forceStop}>
          Dừng &amp; Xóa toàn bộ tiến trình ngầm
        </button>
      </footer>

      <DebugLog />
    </main>
  );
}

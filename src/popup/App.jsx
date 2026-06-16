import React, { useEffect } from 'react';
import { useStore } from './store';
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
} from '../constants';

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
    if (m) return `Bài viết #${m[1]}`;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length ? `Bài viết #${parts[parts.length - 1]}` : url;
  } catch {
    return url;
  }
}

function getPostId(url) {
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
}

function HeaderStats() {
  const items = useStore(s => s.items);
  const batchState = useStore(s => s.batchState);
  const scannedPostUrls = useStore(s => s.scannedPostUrls);

  const getUniqueUrls = (urls) => {
    const seen = new Set();
    const unique = [];
    (urls || []).forEach(url => {
      const id = getPostId(url);
      if (id && !seen.has(id)) {
        seen.add(id);
        unique.push(url);
      }
    });
    return unique;
  };

  const getCommentCountForPost = (url) => {
    const id = getPostId(url);
    if (!id) return 0;
    
    // Check local unsynced items first
    if (Array.isArray(items) && items.length > 0) {
      const count = items.filter(
        item => item.kind === 'COMMENT' && getPostId(item.pageUrl) === id
      ).length;
      if (count > 0) return count;
    }
    
    // Fallback to history
    if (batchState && Array.isArray(batchState.history)) {
      const match = batchState.history.find(h => getPostId(h.postUrl) === id);
      if (match && match.status === 'SUCCESS') {
        return Number(match.comments) || 0;
      }
    }
    return 0;
  };

  const combinedUrls = [...(scannedPostUrls || [])];
  if (Array.isArray(items)) {
    items.forEach(item => {
      if (item.kind === 'POST' && item.pageUrl) {
        combinedUrls.push(item.pageUrl);
      }
    });
  }
  if (batchState && Array.isArray(batchState.history)) {
    batchState.history.forEach(h => {
      if (h.status === 'SUCCESS' && h.postUrl) {
        combinedUrls.push(h.postUrl);
      }
    });
  }

  const uniqueScanned = getUniqueUrls(combinedUrls);
  const postCount = uniqueScanned.length;
  const commentCount = uniqueScanned.reduce((sum, url) => sum + getCommentCountForPost(url), 0);
  const savedCount = Array.isArray(items) ? items.length : 0;

  return (
    <section className="stats">
      <article><strong id="postCount">{postCount}</strong><span>Bài viết</span></article>
      <article><strong id="commentCount">{commentCount}</strong><span>Bình luận</span></article>
      <article><strong id="savedCount">{savedCount}</strong><span>Chờ đồng bộ</span></article>
    </section>
  );
}

function BatchPanel() {
  const batchState = useStore(s => s.batchState);
  const stopBatch = useStore(s => s.stopBatch);

  const status = batchState.status || 'IDLE';
  const current = batchState.current || 0;
  const batchTotal = batchState.batchTotal || 0;
  const message = batchState.message || '';

  const visible = status !== 'IDLE';
  if (!visible) return null;

  const isRunning = status === 'RUNNING';
  const isAwaiting = status === 'AWAITING_CONTINUE';

  let statusLabel = '';
  if (isRunning) statusLabel = `${current}/${batchTotal}`;
  else if (isAwaiting) statusLabel = 'Chờ tiếp tục';
  else if (status === 'CANCELLED') statusLabel = 'Đã dừng';
  else if (status === 'ERROR') statusLabel = 'Lỗi';
  else statusLabel = 'Hoàn tất';

  const pct = batchTotal ? Math.round((current / batchTotal) * 100) : 0;

  return (
    <section id="batchPanel" className="batch-panel">
      <div className="batch-heading">
        <strong>Quét hàng loạt</strong>
        <span id="batchStatus">{statusLabel}</span>
      </div>
      <div className="progress">
        <span id="batchProgress" style={{ width: `${pct}%` }}></span>
      </div>
      <p id="batchMessage">{message || ''}</p>

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
  const scannedPostUrls = useStore(s => s.scannedPostUrls);
  const batchAttemptedPostUrls = useStore(s => s.batchAttemptedPostUrls);
  const items = useStore(s => s.items);
  const rescanFailedPosts = useStore(s => s.rescanFailedPosts);
  const initialScannedUrls = useStore(s => s.initialScannedUrls);
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

  const getCommentCountForPost = (url) => {
    const id = getPostId(url);
    if (!id) return 0;
    if (Array.isArray(items) && items.length > 0) {
      const count = items.filter(
        item => item.kind === 'COMMENT' && getPostId(item.pageUrl) === id
      ).length;
      if (count > 0) return count;
    }
    if (batchState && Array.isArray(batchState.history)) {
      const match = batchState.history.find(h => getPostId(h.postUrl) === id);
      if (match && match.status === 'SUCCESS') {
        return Number(match.comments) || 0;
      }
    }
    return 0;
  };

  return (
    <div className="actions">
      <input id="postUrl" type="url" ref={postUrlRef} placeholder="Dán link bài viết Facebook..." autoComplete="off" />
      <button id="scan" className="primary" disabled={busy} onClick={handleScan}>
        Quét sâu bài viết đang mở
      </button>


      <div className="batch-settings">
        <div className="settings-grid">
          <div className="setting-col">
            <span className="setting-label">Số bài viết</span>
            <input type="number" id="batchCount" min="1" max="500"
              value={batchConfig.limit}
              onChange={e => updateConfig('limit', parseInt(e.target.value) || 10)} />
          </div>
          <div className="setting-col">
            <span className="setting-label">Hạn mỗi bài (s)</span>
            <input type="number" id="batchPostTime" min="10"
              value={batchConfig.postTimeoutSec}
              onChange={e => updateConfig('postTimeoutSec', parseInt(e.target.value) || 120)} />
          </div>
          <div className="setting-col">
            <span className="setting-label">Tổng tối đa (m)</span>
            <input type="number" id="batchTotalTime" min="1"
              value={batchConfig.totalTimeoutMin}
              onChange={e => updateConfig('totalTimeoutMin', parseInt(e.target.value) || 30)} />
          </div>
        </div>
        <label className="checkbox-label">
          <input type="checkbox" id="batchIgnoreScanned"
            checked={batchConfig.ignoreScanned || false}
            onChange={e => updateConfig('ignoreScanned', e.target.checked)} />
          <span>Bỏ qua bài đã quét thành công (Tránh quét trùng)</span>
        </label>
      </div>

        {/* Collapsible Panel for Logs/IDs */}
        {(() => {
          const getUniqueUrls = (urls) => {
            const seen = new Set();
            const unique = [];
            (urls || []).forEach(url => {
              const id = getPostId(url);
              if (id && !seen.has(id)) {
                seen.add(id);
                unique.push(url);
              }
            });
            return unique;
          };

          const uniqueScanned = getUniqueUrls(scannedPostUrls);
          const uniqueAttempted = getUniqueUrls(batchAttemptedPostUrls);

          return (
            <details className="debug-ids-panel" style={{ marginTop: '10px', fontSize: '11px', background: '#f8fafc', padding: '10px', borderRadius: '6px', border: '1px solid #cbd5e1' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 'bold', color: '#475569', outline: 'none' }}>
                📋 Chi tiết hàng chờ bỏ qua bài viết ({uniqueScanned.length + uniqueAttempted.length} bài)
              </summary>
              <div style={{ marginTop: '8px', maxHeight: '220px', overflowY: 'auto' }}>
                
                {/* SECTION 1: Đã quét thành công */}
                <div style={{ marginBottom: '12px' }}>
                  <strong style={{ color: '#1e293b', display: 'block', marginBottom: '4px' }}>1. Đã quét thành công ({uniqueScanned.length}):</strong>
                  {uniqueScanned.length === 0 ? (
                    <div style={{ color: '#94a3b8', paddingLeft: '8px', marginTop: '2px' }}>Trống.</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '4px', fontSize: '10px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #cbd5e1', color: '#475569', textAlign: 'left' }}>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold' }}>ID Bài Viết</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '50px', textAlign: 'center' }}>Comments</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '90px', textAlign: 'right' }}>Trạng Thái</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '70px', textAlign: 'right' }}>Hành Động</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uniqueScanned.map((url, i) => {
                          const id = getPostId(url);
                          const commentCount = getCommentCountForPost(url);
                          const statusText = batchConfig.ignoreScanned ? "Bỏ qua" : "Sẽ quét lại";
                          const statusColor = batchConfig.ignoreScanned ? "#ef4444" : "#2563eb";
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }} title={url}>
                              <td style={{ padding: '4px 2px', fontFamily: 'monospace' }}>
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    color: '#2563eb',
                                    textDecoration: 'none',
                                    fontWeight: 'bold',
                                  }}
                                  onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                                  onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                                >
                                  {id}
                                </a>
                              </td>
                              <td style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 'bold', color: '#0f172a' }}>{commentCount}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'right', color: statusColor, fontWeight: 'bold' }}>{statusText}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'right' }}>
                                <button
                                  disabled={busy}
                                  onClick={() => scanSinglePost(url)}
                                  style={{
                                    padding: '2px 5px',
                                    fontSize: '9px',
                                    background: '#3b82f6',
                                    color: '#ffffff',
                                    border: 'none',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold',
                                    minHeight: 'auto',
                                  }}
                                >
                                  Quét lại
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* SECTION 2: Đã quét/thử quét trong lượt chạy này */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                    <strong style={{ color: '#1e293b' }}>2. Đã quét/thử quét trong lượt chạy này ({uniqueAttempted.length}):</strong>
                    {uniqueAttempted.length > 0 && (
                      <button
                        onClick={rescanFailedPosts}
                        style={{
                          padding: '2px 6px',
                          fontSize: '9px',
                          background: '#ef4444',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          minHeight: 'auto',
                        }}
                      >
                        🔄 Quét lại bài lỗi
                      </button>
                    )}
                  </div>
                  {uniqueAttempted.length === 0 ? (
                    <div style={{ color: '#94a3b8', paddingLeft: '8px', marginTop: '2px' }}>Trống (Sẽ làm mới khi chạy batch mới).</div>
                  ) : (
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '4px', fontSize: '10px' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid #cbd5e1', color: '#475569', textAlign: 'left' }}>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold' }}>ID Bài Viết</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '50px', textAlign: 'center' }}>Comments</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '70px', textAlign: 'center' }}>Phân loại</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '80px', textAlign: 'right' }}>Trạng Thái</th>
                          <th style={{ padding: '4px 2px', fontWeight: 'bold', width: '70px', textAlign: 'right' }}>Hành Động</th>
                        </tr>
                      </thead>
                      <tbody>
                        {uniqueAttempted.map((url, i) => {
                          const id = getPostId(url);
                          
                          let statusText = "Bỏ qua";
                          let commentCount = 0;
                          let statusColor = "#dc2626";
                          
                          if (batchState && Array.isArray(batchState.history)) {
                            const match = batchState.history.find(h => getPostId(h.postUrl) === id);
                            if (match) {
                              if (match.status === 'SUCCESS') {
                                statusText = "Thành công";
                                commentCount = Number(match.comments) || 0;
                                statusColor = "#16a34a";
                              } else {
                                statusText = "Thất bại";
                                commentCount = 0;
                                statusColor = "#dc2626";
                              }
                            }
                          }

                          const isRescan = Array.isArray(initialScannedUrls) && initialScannedUrls.some(u => getPostId(u) === id);
                          const typeText = isRescan ? "Quét lại" : "Bài mới";
                          const typeColor = isRescan ? "#d97706" : "#2563eb";
                          
                          return (
                            <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }} title={url}>
                              <td style={{ padding: '4px 2px', fontFamily: 'monospace' }}>
                                <a
                                  href={url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{
                                    color: '#2563eb',
                                    textDecoration: 'none',
                                    fontWeight: 'bold',
                                  }}
                                  onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'}
                                  onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}
                                >
                                  {id}
                                </a>
                              </td>
                              <td style={{ padding: '4px 2px', textAlign: 'center', fontWeight: 'bold', color: '#0f172a' }}>{commentCount}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'center', color: typeColor, fontWeight: 'bold' }}>{typeText}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'right', color: statusColor, fontWeight: 'bold' }}>{statusText}</td>
                              <td style={{ padding: '4px 2px', textAlign: 'right' }}>
                                <button
                                  disabled={busy}
                                  onClick={() => scanSinglePost(url)}
                                  style={{
                                    padding: '2px 5px',
                                    fontSize: '9px',
                                    background: '#3b82f6',
                                    color: '#ffffff',
                                    border: 'none',
                                    borderRadius: '3px',
                                    cursor: 'pointer',
                                    fontWeight: 'bold',
                                    minHeight: 'auto',
                                  }}
                                >
                                  Quét lại
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </details>
          );
        })()}

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
  const rawItems = useStore(s => s.items);
  const items = Array.isArray(rawItems) ? rawItems : [];
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
  const rawLogs = useStore(s => s.logs);
  const logs = Array.isArray(rawLogs) ? rawLogs : [];
  const batchState = useStore(s => s.batchState);
  
  const allLogs = [...logs];
  if (batchState.message && !allLogs.some(l => l.includes(batchState.message))) {
    allLogs.push(`[Batch] ${batchState.message}`);
  }

  const logRef = React.useRef(null);
  // Auto-scroll xuống dưới khi có log mới
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [allLogs.length]);

  return (
    <div className="panel">
      <h3 className="panel-header">Console Log</h3>
      <div id="debugLog" ref={logRef} style={{ height: '120px', overflowY: 'auto', background: '#f0f2f5', padding: '8px', fontFamily: 'monospace', fontSize: '11px', borderRadius: '4px' }}>
        {allLogs.length === 0 ? <span style={{color:'#94a3b8'}}>Chưa có log nào.</span> : allLogs.map((l, i) => <div key={i} style={{marginBottom:'2px'}}>{l}</div>)}
      </div>
    </div>
  );
}

function CacheModal({ onClose }) {
  const [cacheData, setCacheData] = React.useState({});
  const [loading, setLoading] = React.useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const data = await chrome.storage.local.get(null);
      setCacheData(data || {});
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  React.useEffect(() => {
    loadData();
  }, []);

  const KEY_MEANINGS = {
    [STORAGE_KEY]: 'Bộ nhớ đệm chứa bài viết & bình luận đã quét (chờ đồng bộ lên Backend)',
    [META_KEY]: 'Thông tin tổng hợp của lượt quét gần nhất (thời gian, URL, số lượng)',
    [BATCH_STATE_KEY]: 'Trạng thái và lịch sử chi tiết của tiến trình quét hàng loạt (Batch Scan)',
    [BATCH_CONFIG_KEY]: 'Cấu hình giới hạn số bài & thời gian cho quét hàng loạt',
    [API_URL_KEY]: 'Địa chỉ kết nối đến API cổng Backend (BE)',
    [TOKEN_KEY]: 'Mã Token xác thực để được phép gửi dữ liệu lên Backend',
    [SCANNED_URLS_KEY]: 'Danh sách URL các bài viết đã quét thành công (để tránh quét trùng)',
    [BATCH_ATTEMPTED_URLS_KEY]: 'Danh sách URL các bài viết đã thử quét/bị lỗi trong lượt chạy này',
    [LEAD_ANALYSIS_KEY]: 'Dữ liệu phân tích lọc Lead tuyển sinh lưu trữ cục bộ',
  };

  const getMeaning = (key) => KEY_MEANINGS[key] || 'Dữ liệu hệ thống / Khác';

  const formatValue = (val) => {
    if (val === undefined || val === null) return 'null';
    if (Array.isArray(val)) {
      return `Mảng [${val.length} phần tử]`;
    }
    if (typeof val === 'object') {
      return `Đối tượng {${Object.keys(val).length} trường}`;
    }
    return String(val);
  };

  const allKeys = Object.keys(cacheData).sort();

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.45)',
      backdropFilter: 'blur(4px)',
      zIndex: 9999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
    }}>
      <div style={{
        backgroundColor: '#ffffff',
        borderRadius: '14px',
        width: '100%',
        maxWidth: '560px',
        maxHeight: '90vh',
        boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1), 0 8px 10px -6px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #e2e8f0',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          padding: '12px 16px',
          borderBottom: '1px solid #f1f5f9',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8fafc',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '18px' }}>🗄️</span>
            <strong style={{ fontSize: '14px', color: '#1e293b' }}>Chi tiết Cache (chrome.storage.local)</strong>
          </div>
          <button 
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '18px',
              cursor: 'pointer',
              color: '#94a3b8',
              fontWeight: 'bold',
              minHeight: 'auto',
              padding: '4px 8px',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#475569'}
            onMouseLeave={e => e.currentTarget.style.color = '#94a3b8'}
          >
            ✕
          </button>
        </div>

        {/* Content */}
        <div style={{
          padding: '16px',
          overflowY: 'auto',
          flex: 1,
        }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '32px', color: '#64748b' }}>Đang tải dữ liệu cache...</div>
          ) : allKeys.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px', color: '#94a3b8' }}>Cache trống rỗng.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <table style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '11px',
                textAlign: 'left',
              }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid #cbd5e1', color: '#475569' }}>
                    <th style={{ padding: '6px 4px', fontWeight: 'bold' }}>Tên Key</th>
                    <th style={{ padding: '6px 4px', fontWeight: 'bold' }}>Ý nghĩa</th>
                    <th style={{ padding: '6px 4px', fontWeight: 'bold' }}>Giá trị</th>
                  </tr>
                </thead>
                <tbody>
                  {allKeys.map((key) => {
                    const val = cacheData[key];
                    return (
                      <tr key={key} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '8px 4px', fontWeight: 'bold', color: '#0f172a', wordBreak: 'break-all', maxWidth: '120px' }}>{key}</td>
                        <td style={{ padding: '8px 4px', color: '#64748b', maxWidth: '140px' }}>{getMeaning(key)}</td>
                        <td style={{ padding: '8px 4px' }}>
                          <details style={{ cursor: 'pointer' }}>
                            <summary style={{ color: '#2563eb', fontWeight: '500', outline: 'none' }}>
                              {formatValue(val)}
                            </summary>
                            <pre style={{
                              marginTop: '6px',
                              padding: '8px',
                              background: '#f1f5f9',
                              borderRadius: '6px',
                              fontSize: '10px',
                              overflowX: 'auto',
                              maxHeight: '160px',
                              color: '#334155',
                              fontFamily: 'monospace',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-all',
                            }}>
                              {JSON.stringify(val, null, 2)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid #f1f5f9',
          display: 'flex',
          justifyContent: 'end',
          gap: '8px',
          backgroundColor: '#f8fafc',
        }}>
          <button 
            onClick={loadData}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              borderColor: '#cbd5e1',
              color: '#475569',
              minHeight: '32px',
            }}
          >
            🔄 Tải lại
          </button>
          <button 
            onClick={onClose}
            style={{
              padding: '6px 12px',
              fontSize: '12px',
              borderRadius: '6px',
              backgroundColor: '#475569',
              color: '#ffffff',
              border: 'none',
              fontWeight: 'bold',
              minHeight: '32px',
            }}
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const init = useStore(s => s.init);
  const statusMsg = useStore(s => s.statusMsg);
  const statusError = useStore(s => s.statusError);
  const forceStop = useStore(s => s.forceStop);
  const exportJson = useStore(s => s.exportJson);
  const loadBatchState = useStore(s => s.loadBatchState);
  const [showCache, setShowCache] = React.useState(false);

  useEffect(() => {
    init();
    // Poll batch state mỗi 1.5s khi đang chạy
    const interval = setInterval(loadBatchState, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <main>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
          <div className="logo">D</div>
          <div>
            <h1>DAO EDU Scanner</h1>
            <p>Thử nghiệm quét Facebook</p>
          </div>
        </div>
        <button 
          title="Xem chi tiết Cache" 
          onClick={() => setShowCache(true)}
          style={{
            background: 'none',
            border: 'none',
            color: '#15803d',
            cursor: 'pointer',
            padding: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '50%',
            transition: 'background 0.2s',
            minHeight: 'auto',
          }}
          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#ecfdf5'}
          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 5V19c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 5c0 1.7 4 3 9 3s9-1.3 9-3"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/></svg>
        </button>
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
        <button id="exportJson" className="sync-button" onClick={exportJson}
          style={{ gridColumn: '1 / -1', borderColor: '#7c3aed', color: '#7c3aed', background: '#f5f3ff' }}>
          ⬇️ Xuất file JSON Raw
        </button>
        <button id="forceStop" className="danger clear-all" onClick={forceStop}>
          Dừng &amp; Xóa toàn bộ tiến trình ngầm
        </button>
      </footer>

      <DebugLog />
      {showCache && <CacheModal onClose={() => setShowCache(false)} />}
    </main>
  );
}

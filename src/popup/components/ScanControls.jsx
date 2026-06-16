import React, { useState } from 'react';
import { useStore } from '../store';

export default function ScanControls() {
  const batchState = useStore((state) => state.batchState);
  const items = useStore((state) => state.items);
  
  const [config, setConfig] = useState({
    batchLimit: 5,
    postTimeoutMs: 15000,
    ignoreScanned: true
  });

  const isRunning = batchState.status === 'RUNNING';
  const isAwaiting = batchState.status === 'AWAITING_CONTINUE';
  const hasItems = items.length > 0;

  const handleStartGroupScan = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    chrome.runtime.sendMessage({
      type: 'START_GROUP_SCAN_BATCH',
      tabId: tabs[0].id,
      config
    });
  };

  const handleContinueGroupScan = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    chrome.runtime.sendMessage({
      type: 'CONTINUE_GROUP_SCAN_BATCH',
      tabId: tabs[0].id,
    });
  };

  const handleCancelGroupScan = () => {
    chrome.runtime.sendMessage({ type: 'CANCEL_GROUP_SCAN_BATCH' });
  };

  const handleSyncToBackend = async () => {
    if (!hasItems) return;
    try {
      const { daoEduLeadScannerToken } = await chrome.storage.local.get("daoEduLeadScannerToken");
      const { daoEduLeadScannerApiBaseUrl } = await chrome.storage.local.get("daoEduLeadScannerApiBaseUrl");
      const apiBaseUrl = (daoEduLeadScannerApiBaseUrl || "http://localhost:5000/api").replace(/\/+$/, '');

      if (!daoEduLeadScannerToken) {
        alert("Lỗi: Bạn chưa nhập Token kết nối API! Vui lòng vào Tùy chọn để nhập Token.");
        return;
      }

      const response = await fetch(`${apiBaseUrl}/facebook-lead-scans`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-dao-edu-scanner-token": daoEduLeadScannerToken,
        },
        body: JSON.stringify({ items }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `API loi: ${response.status}`);
      }

      const responseData = await response.json();
      await chrome.storage.local.set({ daoEduLeadScannerItems: [] });
      alert(`Thành công! Đã đồng bộ ${responseData.data?.itemCount || 0} mục lên BE.`);
      
      // Auto refresh BE list
      handlePullFromBackend();
    } catch (e) {
      alert(`Đồng bộ thất bại: ${e.message}`);
    }
  };

  const handlePullFromBackend = async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0]) return;
    
    // Xóa state rác cục bộ để lấy dữ liệu mới từ BE đắp vào top bar
    await chrome.storage.local.set({ daoEduLeadScannerItems: [] });

    chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_SYNC_SCANNED_POSTS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError.message);
      }
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
      {!isRunning && !isAwaiting && (
        <button className="primary" onClick={handleStartGroupScan}>Bắt đầu Quét hàng loạt</button>
      )}
      
      {isAwaiting && (
        <button className="primary" onClick={handleContinueGroupScan}>Quét tiếp phần còn lại</button>
      )}

      {isRunning && (
        <button className="danger" onClick={handleCancelGroupScan}>Dừng Quét</button>
      )}

      <button className="secondary" onClick={handleSyncToBackend} disabled={!hasItems}>
        Đồng bộ Data lên BE &amp; Xóa local
      </button>

      <button className="secondary" onClick={handlePullFromBackend}>
        Tải lại Tem đã quét từ BE xuống
      </button>

      <div className="section-card" style={{ marginTop: '16px' }}>
        <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>Cấu hình quét Group/Page</h3>
        
        <div style={{ marginBottom: '8px' }}>
          <label style={{ fontSize: '12px' }}>Số bài mỗi đợt:</label>
          <input 
            type="number" 
            value={config.batchLimit} 
            onChange={e => setConfig({...config, batchLimit: Number(e.target.value)})}
            style={{ width: '60px', marginLeft: '8px', padding: '4px' }}
          />
        </div>

        <div style={{ marginBottom: '8px' }}>
          <label style={{ fontSize: '12px' }}>Thời gian dừng xem 1 bài (ms):</label>
          <input 
            type="number" 
            value={config.postTimeoutMs} 
            onChange={e => setConfig({...config, postTimeoutMs: Number(e.target.value)})}
            style={{ width: '80px', marginLeft: '8px', padding: '4px' }}
          />
        </div>

        <div>
          <label style={{ fontSize: '12px', display: 'flex', alignItems: 'center' }}>
            <input 
              type="checkbox" 
              checked={config.ignoreScanned} 
              onChange={e => setConfig({...config, ignoreScanned: e.target.checked})}
              style={{ marginRight: '6px' }}
            />
            Chỉ quét bài mới (Bỏ qua bài đã dán tem)
          </label>
        </div>
      </div>
    </div>
  );
}

import React from 'react';
import { useStore } from '../store';

export default function HistoryList() {
  const batchState = useStore((state) => state.batchState);
  const history = batchState.history || [];

  if (history.length === 0) {
    return <div className="empty" style={{ textAlign: 'center', padding: '16px', color: 'var(--text-secondary)' }}>Chưa có dữ liệu.</div>;
  }

  return (
    <div id="batchHistory">
      {history.map((item, index) => {
        const displayUrl = item.postUrl || "Bài viết";
        let shortUrl = displayUrl;
        try {
          const u = new URL(displayUrl);
          const parts = u.pathname.split('/').filter(Boolean);
          shortUrl = parts.length > 0 ? "Bài viết #" + parts[parts.length - 1] : displayUrl;
        } catch (e) {
          // ignore
        }

        const isError = item.status === "ERROR";
        
        return (
          <div key={index} className="history-item" style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            padding: '8px 0', 
            borderBottom: '1px solid var(--border-color)',
            alignItems: 'center'
          }}>
            <a 
              href={displayUrl} 
              target="_blank" 
              rel="noopener noreferrer" 
              className="history-url"
              style={{ color: isError ? '#ff4d4f' : 'var(--primary-color)', textDecoration: 'none', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '200px' }}
            >
              {shortUrl}
            </a>
            <span className="history-comments" style={{ fontSize: '13px', fontWeight: 'bold', color: 'var(--primary-color)' }}>
              {isError ? 'Lỗi' : `${item.comments || 0} bình luận`}
            </span>
          </div>
        );
      })}
    </div>
  );
}

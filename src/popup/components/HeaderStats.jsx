import React from 'react';
import { useStore } from '../store';

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

export default function HeaderStats() {
  const items = useStore((state) => state.items);
  const batchState = useStore((state) => state.batchState);
  const scannedPostUrls = useStore((state) => state.scannedPostUrls);

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
    <div className="stats-row">
      <div className="stat-card">
        <div className="stat-value" id="postCount">{postCount}</div>
        <div className="stat-label">Bài viết</div>
      </div>
      <div className="stat-card">
        <div className="stat-value" id="commentCount">{commentCount}</div>
        <div className="stat-label">Bình luận</div>
      </div>
      <div className="stat-card">
        <div className="stat-value" id="savedCount">{savedCount}</div>
        <div className="stat-label">Đã lưu</div>
      </div>
    </div>
  );
}

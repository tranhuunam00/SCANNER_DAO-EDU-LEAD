import React from 'react';
import { useStore } from '../store';

export default function HeaderStats() {
  const items = useStore((state) => state.items);
  const batchState = useStore((state) => state.batchState);
  const meta = useStore((state) => state.meta);

  // Tính toán số liệu: Nếu items (chưa đồng bộ) đang trống, thử dùng số liệu từ history (BE hoặc Quét hàng loạt)
  let postCount = 0;
  let commentCount = 0;
  let savedCount = 0;

  if (items && items.length > 0) {
    postCount = items.filter((item) => item.kind === "POST").length;
    commentCount = items.filter((item) => item.kind === "COMMENT").length;
    savedCount = items.length;
  } else if (batchState && batchState.history && batchState.history.length > 0) {
    postCount = batchState.history.length;
    commentCount = batchState.history.reduce((sum, item) => sum + (Number(item.comments) || 0), 0);
    savedCount = postCount;
  }

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

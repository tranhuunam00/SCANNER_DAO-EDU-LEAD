import React from 'react';
import { useStore } from '../store';

export default function BatchProgress() {
  const batchState = useStore((state) => state.batchState);

  const isRunning = batchState.status === 'RUNNING';
  const isAwaiting = batchState.status === 'AWAITING_CONTINUE';
  const isCompleted = batchState.status === 'COMPLETED';
  const isCancelled = batchState.status === 'CANCELLED';
  const isError = batchState.status === 'ERROR';

  if (!isRunning && !isAwaiting && !isCompleted && !isCancelled && !isError) {
    return null; // IDLE hoặc rỗng thì ẩn đi
  }

  let statusLabel = '';
  let progressColor = 'var(--primary-color)';

  if (isRunning) statusLabel = 'Đang chạy...';
  if (isAwaiting) statusLabel = 'Chờ tiếp tục';
  if (isCompleted) {
    statusLabel = 'Hoàn tất';
    progressColor = '#52c41a';
  }
  if (isCancelled) {
    statusLabel = 'Đã hủy';
    progressColor = '#faad14';
  }
  if (isError) {
    statusLabel = 'Lỗi';
    progressColor = '#ff4d4f';
  }

  // Giả lập tiến trình hiển thị (vì chúng ta không biết chính xác tổng số bài sẽ quét, hiển thị % xoay vòng hoặc cứng)
  let pct = 0;
  if (isCompleted) pct = 100;
  else if (isRunning || isAwaiting) pct = 100; // Thanh chạy đầy và chớp nháy (theo css cũ)
  
  const historyCount = batchState.history?.length || 0;
  const errorCount = batchState.history?.filter(x => x.status === 'ERROR').length || 0;
  const successCount = historyCount - errorCount;

  return (
    <div className="section-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--text-color)' }}>Quét hàng loạt</h3>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{statusLabel}</span>
      </div>
      
      <div className="progress-container">
        <div 
          className="progress-bar" 
          style={{ width: `${pct}%`, backgroundColor: progressColor, transition: 'width 0.3s' }}
        ></div>
      </div>

      <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '8px' }}>
        {batchState.message || `Đã xử lý ${historyCount} bài: ${successCount} thành công, ${errorCount} lỗi.`}
      </div>
    </div>
  );
}

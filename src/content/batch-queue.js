(function exposeBatchQueue(root) {
  function extractPostId(urlStr) {
    try {
      const match = String(urlStr).match(/\/(?:posts|permalink|videos|photos\/a\.[^/]+)\/([^/?]+)/);
      return match ? match[1] : String(urlStr);
    } catch {
      return String(urlStr);
    }
  }

  function create(limit, excludedUrls = []) {
    const maximum = Math.max(0, Math.floor(Number(limit) || 0));
    const knownIds = new Set();
    
    (excludedUrls || []).forEach(url => {
      const id = extractPostId(url);
      if (id) {
        knownIds.add(id);
      }
    });

    console.log(`[BatchQueue] Khoi tao hang cho voi limit = ${maximum}. Danh sach loai tru (scanned/attempted) co ${knownIds.size} IDs:`, [...knownIds]);
    const queuedUrls = [];

    return {
      append(urls) {
        let addedCount = 0;
        let skippedCount = 0;
        for (const value of urls || []) {
          const url = String(value || '');
          const id = extractPostId(url);
          if (!url || !id) continue;
          
          if (knownIds.has(id)) {
            if (!queuedUrls.includes(url)) {
              console.log(`[BatchQueue] Bo qua post ID: "${id}" vi da co trong danh sach da quet/da thu. Link: ${url}`);
              skippedCount++;
            }
            continue;
          }
          if (queuedUrls.length >= maximum) {
            console.log(`[BatchQueue] Bo qua post ID: "${id}" vi hang cho da dat gioi han toi da (${maximum}). Link: ${url}`);
            continue;
          }
          knownIds.add(id);
          queuedUrls.push(url);
          addedCount++;
          console.log(`[BatchQueue] Them moi post ID: "${id}" vao hang cho. Link: ${url}`);
        }
        if (addedCount > 0 || skippedCount > 0) {
          console.log(`[BatchQueue] Ket qua append: Them moi ${addedCount} bai, bo qua ${skippedCount} bai da quet. Tong so trong hang cho hien tai: ${queuedUrls.length}/${maximum}`);
        }
        return queuedUrls.length;
      },
      isFull() {
        return queuedUrls.length >= maximum;
      },
      values() {
        return [...queuedUrls];
      },
      get size() {
        return queuedUrls.length;
      },
    };
  }

  root.DaoEduBatchQueue = { create };
})(globalThis);

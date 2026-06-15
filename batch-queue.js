(function exposeBatchQueue(root) {
  function create(limit, excludedUrls = []) {
    const maximum = Math.max(0, Math.floor(Number(limit) || 0));
    const knownUrls = new Set(
      (excludedUrls || []).map(String).filter(Boolean),
    );
    const queuedUrls = [];

    return {
      append(urls) {
        for (const value of urls || []) {
          const url = String(value || '');
          if (!url || knownUrls.has(url) || queuedUrls.length >= maximum) {
            continue;
          }
          knownUrls.add(url);
          queuedUrls.push(url);
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

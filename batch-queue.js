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
    const knownIds = new Set(
      (excludedUrls || []).map(url => extractPostId(url)).filter(Boolean)
    );
    const queuedUrls = [];

    return {
      append(urls) {
        for (const value of urls || []) {
          const url = String(value || '');
          const id = extractPostId(url);
          if (!url || !id || knownIds.has(id) || queuedUrls.length >= maximum) {
            continue;
          }
          knownIds.add(id);
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

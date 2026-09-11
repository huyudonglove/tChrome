const describeDownload = (item) => ({
  id: item.id, filename: item.filename, state: item.state,
  bytesReceived: item.bytesReceived, totalBytes: item.totalBytes,
  paused: item.paused, exists: item.exists,
  ...(item.error ? {error: item.error} : {}),
});

export const waitForDownload = (input) => {
  const {downloadId, timeoutMs = 10000} = input;
  if (!Number.isInteger(downloadId) || downloadId < 0) {
    return Promise.resolve({ok: false, error: 'downloadId 必须是非负整数'});
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15000) {
    return Promise.resolve({ok: false, error: 'timeoutMs 必须是 1～15000 的整数'});
  }
  return new Promise((resolve) => {
    let settled = false;
    let querying = false;
    let dirty = false;
    let latest;
    const downloads = chrome.downloads;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      downloads.onChanged.removeListener(onChanged);
      downloads.onErased.removeListener(onErased);
      resolve(result);
    };
    const inspect = async () => {
      if (settled) return;
      if (querying) { dirty = true; return; }
      querying = true;
      try {
        do {
          dirty = false;
          const [item] = await downloads.search({id: downloadId});
          if (settled) return;
          // A change arriving during search may make its snapshot obsolete.
          if (dirty) continue;
          if (!item) {
            finish({ok: false, code: 'download_not_found', downloadId, error: '找不到该下载记录'});
            return;
          }
          latest = describeDownload(item);
          if (item.state === 'complete') finish({ok: true, download: latest});
          else if (item.state === 'interrupted') {
            finish({ok: false, code: 'download_interrupted', download: latest,
              error: `下载已中断：${item.error || '未知原因'}`});
          }
        } while (dirty && !settled);
      } catch (error) {
        finish({ok: false, code: 'download_query_failed', downloadId,
          error: error instanceof Error ? error.message : String(error)});
      } finally { querying = false; }
    };
    const onChanged = (delta) => { if (delta.id === downloadId) void inspect(); };
    const onErased = (id) => {
      if (id === downloadId) finish({ok: false, code: 'download_not_found', downloadId, error: '下载记录已被删除'});
    };
    const timer = setTimeout(() => finish({ok: false, code: 'download_timeout', downloadId,
      ...(latest ? {download: latest} : {}), error: '等待下载完成超时；可使用同一 downloadId 继续等待'}), timeoutMs);
    try {
      // Register before querying so completion between these operations is observed.
      downloads.onChanged.addListener(onChanged);
      downloads.onErased.addListener(onErased);
      void inspect();
    } catch (error) {
      finish({ok: false, code: 'download_query_failed', downloadId,
        error: error instanceof Error ? error.message : String(error)});
    }
  });
};

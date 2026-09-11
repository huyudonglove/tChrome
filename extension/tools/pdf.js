import {withDebugger} from './dialogs.js';
import {waitForDownload} from './downloads.js';

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const bounded = async (promise, ms, code) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(code), {code})), ms);
    })]);
  } finally { clearTimeout(timer); }
};

export const savePagePdf = async (tabId, input = {}) => {
  const filename = input.filename ?? `tchrome-${Date.now()}.pdf`;
  const timeoutMs = input.timeoutMs ?? 5000;
  if (typeof filename !== 'string' || filename.length > 240 || !/\.pdf$/i.test(filename)
    || /[\\:\x00-\x1f\x7f?*"<>|]/.test(filename)
    || filename.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    return {ok: false, code: 'invalid_filename', error: 'filename 必须是下载目录内的相对 PDF 文件名；不允许绝对路径、路径穿越或非法文件名'};
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    return {ok: false, code: 'invalid_timeout', error: 'timeoutMs 必须是 1～5000 的整数（下载完成等待时间）'};
  }
  let downloadId;
  let printActive = true;
  try {
    let pdf;
    try {
      pdf = await bounded(withDebugger(tabId, () => {
        if (!printActive) throw new Error('PDF preparation expired');
        return chrome.debugger.sendCommand({tabId}, 'Page.printToPDF', {
          printBackground: true, preferCSSPageSize: true, transferMode: 'ReturnAsBase64',
        });
      }, {retryDetached: false}), 10000, 'pdf_print_timeout');
    } finally { printActive = false; }
    const data = pdf?.data;
    if (typeof data !== 'string' || !data.startsWith('JVBERi0')
      || data.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      return {ok: false, code: 'invalid_pdf', error: '浏览器未返回有效 PDF，或 PDF 超过 20 MiB 限制'};
    }
    downloadId = await bounded(chrome.downloads.download({
      url: `data:application/pdf;base64,${data}`, filename, saveAs: false, conflictAction: 'uniquify',
    }), 3000, 'pdf_download_start_timeout');
    const result = await waitForDownload({downloadId, timeoutMs});
    return {...result, tab: tabId, downloadId,
      ...(result.ok ? {path: result.download.filename} : {}),
      ...(result.code === 'download_timeout' ? {status: 'pending'} : {})};
  } catch (error) {
    // Do not expose API error text: a download error can include its data URL.
    const code = error?.code || 'pdf_save_failed';
    const unsupported = /not implemented|not supported|wasn.t found|method not found/i.test(String(error));
    return {ok: false, tab: tabId, code: unsupported ? 'pdf_not_supported' : code,
      ...(downloadId !== undefined ? {downloadId} : {}),
      error: unsupported ? '当前浏览器不支持 Page.printToPDF，未保存 PDF'
        : code === 'pdf_download_start_timeout' ? '启动下载超时，下载可能已开始；请先检查 list_downloads，避免重复保存'
        : code === 'pdf_print_timeout' ? '生成 PDF 超时，未启动下载'
        : '保存 PDF 失败，请检查浏览器调试连接和下载状态'};
  }
};

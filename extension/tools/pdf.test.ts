import {afterEach, expect, test} from 'bun:test';
import {savePagePdf} from './pdf.js';

const globals = globalThis as any;
const originalChrome = globals.chrome;
afterEach(() => { globals.chrome = originalChrome; });
const event = () => ({addListener() {}, removeListener() {}});
function setup(state = 'complete') {
  const commands: any[] = [];
  const downloads: any[] = [];
  globals.chrome = {
    debugger: {onEvent: event(), onDetach: event(), attach: async () => {},
      sendCommand: async (...args: any[]) => { commands.push(args); return {data: btoa('%PDF-1.7\nmock')}; }},
    tabs: {onRemoved: event()},
    downloads: {onChanged: event(), onErased: event(),
      download: async (options: any) => { downloads.push(options); return 17; },
      search: async () => [{id: 17, state, filename: '/Downloads/report (1).pdf'}]},
  };
  return {commands, downloads};
}

test('save_pdf prints once, confirms download and returns local path without PDF content', async () => {
  const mock = setup();
  const result = await savePagePdf(9101, {filename: 'report.pdf'});
  expect(mock.commands).toEqual([[{tabId: 9101}, 'Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true, transferMode: 'ReturnAsBase64',
  }]]);
  expect(mock.downloads[0]).toMatchObject({filename: 'report.pdf', conflictAction: 'uniquify', saveAs: false});
  expect(mock.downloads[0].url).toStartWith('data:application/pdf;base64,');
  expect(result).toMatchObject({ok: true, downloadId: 17, path: '/Downloads/report (1).pdf'});
  expect(JSON.stringify(result)).not.toContain('base64');
});

test('save_pdf rejects unsafe filenames before accessing Chrome', async () => {
  const mock = setup();
  for (const filename of ['/tmp/x.pdf', '../x.pdf', 'a/../x.pdf', 'C:\\x.pdf', 'a//x.pdf', 'x.txt']) {
    expect(await savePagePdf(9102, {filename})).toMatchObject({ok: false, code: 'invalid_filename'});
  }
  expect(mock.commands).toHaveLength(0);
  expect(mock.downloads).toHaveLength(0);
});

test('save_pdf distinguishes queued download from saved file', async () => {
  setup('in_progress');
  expect(await savePagePdf(9103, {timeoutMs: 1})).toMatchObject({
    ok: false, status: 'pending', code: 'download_timeout', downloadId: 17,
  });
});

test('save_pdf reports unsupported printing and sanitizes errors without retrying', async () => {
  const mock = setup();
  let calls = 0;
  globals.chrome.debugger.sendCommand = async () => {
    calls++;
    throw new Error('Printing is not supported data:application/pdf;base64,secret');
  };
  const result = await savePagePdf(9104);
  expect(result).toMatchObject({ok: false, code: 'pdf_not_supported'});
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(calls).toBe(1);
  expect(mock.downloads).toHaveLength(0);
});

import {afterEach, expect, test} from 'bun:test';
import {waitForDownload} from './downloads.js';

const globals = globalThis as any;
const originalChrome = globals.chrome;
afterEach(() => { globals.chrome = originalChrome; });
const event = () => {
  const listeners = new Set<(value: any) => void>();
  return {listeners, addListener: (fn: any) => listeners.add(fn), removeListener: (fn: any) => listeners.delete(fn),
    emit: (value: any) => { for (const fn of listeners) fn(value); }};
};
function setup(search: (query: any) => Promise<any[]>) {
  const onChanged = event();
  const onErased = event();
  globals.chrome = {downloads: {search, onChanged, onErased}};
  return {onChanged, onErased, cleaned: () => {
    expect(onChanged.listeners.size).toBe(0);
    expect(onErased.listeners.size).toBe(0);
  }};
}

test('wait_download catches completion during initial search and returns final filename', async () => {
  let finishInitial!: (items: any[]) => void;
  let queries = 0;
  const mock = setup(async (query) => {
    expect(query).toEqual({id: 7});
    expect(mock.onChanged.listeners.size).toBe(1);
    if (++queries === 1) return new Promise((resolve) => { finishInitial = resolve; });
    return [{id: 7, state: 'complete', filename: '/tmp/final.pdf'}];
  });
  const pending = waitForDownload({downloadId: 7, timeoutMs: 100});
  mock.onChanged.emit({id: 99, state: {current: 'complete'}});
  mock.onChanged.emit({id: 7, state: {current: 'complete'}});
  finishInitial([{id: 7, state: 'in_progress', filename: '/tmp/partial'}]);
  expect(await pending).toMatchObject({ok: true, download: {id: 7, state: 'complete', filename: '/tmp/final.pdf'}});
  expect(queries).toBe(2);
  mock.cleaned();
});

test('wait_download reports interruption, missing record and query failure and cleans listeners', async () => {
  for (const [search, code] of [
    [async () => [{id: 7, state: 'interrupted', error: 'NETWORK_FAILED'}], 'download_interrupted'],
    [async () => [], 'download_not_found'],
    [async () => { throw new Error('API unavailable'); }, 'download_query_failed'],
  ] as const) {
    const mock = setup(search);
    expect(await waitForDownload({downloadId: 7})).toMatchObject({ok: false, code});
    mock.cleaned();
  }
});

test('wait_download handles deleted records and timeout even if search never returns', async () => {
  let mock = setup(async () => new Promise(() => {}));
  const pending = waitForDownload({downloadId: 7});
  mock.onErased.emit(7);
  expect(await pending).toMatchObject({ok: false, code: 'download_not_found'});
  mock.cleaned();
  mock = setup(async () => new Promise(() => {}));
  expect(await waitForDownload({downloadId: 7, timeoutMs: 1})).toMatchObject({ok: false, code: 'download_timeout'});
  mock.cleaned();
});

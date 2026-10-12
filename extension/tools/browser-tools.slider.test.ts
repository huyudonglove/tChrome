import {afterEach, expect, test} from 'bun:test';
import {runBrowserTool} from './browser-tools.js';

const globals = globalThis as any;
const original = {chrome: globals.chrome, document: globals.document};
afterEach(() => { globals.chrome = original.chrome; globals.document = original.document; });

// A 300x200 background and a transparent 50x200 data-URI strip cut from x=137.
// The canvas stub returns decoded pixels, while the real serialized page probe does the matching.
const puzzle = (onRelease: 'success' | 'replace') => {
  const width = 300, height = 200, stripWidth = 50, target = 137;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const strip = new Uint8ClampedArray(stripWidth * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const n = (y * width + x) * 4;
    const v = ((Math.imul(x + 11, 73856093) ^ Math.imul(y + 29, 19349663) ^ Math.imul(x * y + 7, 83492791)) >>> 8) & 255;
    pixels[n] = pixels[n + 1] = pixels[n + 2] = v; pixels[n + 3] = 255;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < stripWidth; x++) {
    const n = (y * stripWidth + x) * 4, b = (y * width + target + x) * 4;
    strip[n] = strip[n + 1] = strip[n + 2] = pixels[b]!;
    strip[n + 3] = x >= 2 && x < stripWidth - 2 && y >= 2 && y < height - 2 ? 255 : 0;
  }
  let moved = 0, released = false;
  const rect = (left: number, top: number, w: number, h: number) =>
    ({left, top, width: w, height: h, right: left + w, bottom: top + h});
  const root: any = {parentElement: null, contains: (el: any) => el === piece};
  const container: any = {parentElement: root};
  const bg: any = {src: 'data:image/png;base64,Ymc=', isConnected: true, naturalWidth: width, naturalHeight: height,
    parentElement: container, className: '', getBoundingClientRect: () => rect(0, 100, width, height), data: pixels};
  const piece: any = {src: 'data:image/png;base64,cGllY2U=', isConnected: true, naturalWidth: stripWidth, naturalHeight: height,
    parentElement: container, getBoundingClientRect: () => rect(10 + moved, 100, stripWidth, height), data: strip};
  const handle: any = {tagName: 'BUTTON', className: 'slider-handle', getAttribute: () => null,
    getBoundingClientRect: () => rect(10 + moved, 310, 40, 40)};
  const rail: any = {className: '', querySelectorAll: () => [handle]};
  root.parentElement = rail;
  globals.document = {
    body: root,
    querySelector: (selector: string) => ({'#bg': bg, '#piece': piece, '#rail': rail} as any)[selector] ?? null,
    querySelectorAll: (selector: string) => selector === 'img' ? [bg, piece] : [],
    createElement: (tag: string) => {
      expect(tag).toBe('canvas');
      let image: any;
      return {getContext: () => ({drawImage: (im: any) => {image = im;},
        getImageData: () => ({data: image.data})})};
    },
  };
  const mouse: any[] = [];
  globals.chrome = {
    tabs: {get: async () => ({id: 8731, url: 'https://example.test/register'})},
    scripting: {executeScript: async ({func, args}: any) => [{result: func(...args)}]},
    debugger: {
      onEvent: {addListener() {}, removeListener() {}},
      onDetach: {addListener() {}}, attach: async () => {},
      sendCommand: async (_: any, name: string, params: any) => {
        if (name === 'Input.dispatchMouseEvent') {
          mouse.push(params);
          if (params.type === 'mouseMoved') moved = params.x - 30;
          if (params.type === 'mouseReleased') {
            released = true;
            if (onRelease === 'success') rail.className = 'verified';
            else { bg.isConnected = false; moved = 0; }
          }
        }
        return {};
      },
    },
  };
  return {mouse, state: () => ({moved, released})};
};

test('solve_slider matches a transparent same-height data-URI strip and measures movement before release', async () => {
  const {mouse, state} = puzzle('success');
  const result = await runBrowserTool('solve_slider', {tabId: 8731, bgSelector: '#bg', pieceSelector: '#piece',
    sliderSelector: '#rail', maxAttempts: 1, humanize: {overshoot: false, noise: false, releaseJitter: false}}) as any;
  expect(result).toMatchObject({ok: true, status: 'solved', attempts: [{dxImg: 137, dx: 127, pieceMoved: 127}]});
  expect(state().released).toBe(true);
  expect(mouse[0].type).toBe('mousePressed');
  expect(mouse.at(-1).type).toBe('mouseReleased');
});

test('solve_slider auto-locates the narrow piece and actual rail handle', async () => {
  const {mouse} = puzzle('success');
  const result = await runBrowserTool('solve_slider', {tabId: 8731, maxAttempts: 1,
    humanize: {overshoot: false, noise: false, releaseJitter: false}}) as any;
  expect(result).toMatchObject({ok: true, status: 'solved', attempts: [{dxImg: 137, dx: 127}]});
  expect(mouse[0]).toMatchObject({type: 'mousePressed', x: 30, y: 330});
});

test('solve_slider does not treat a replaced puzzle as a passed challenge', async () => {
  const {state} = puzzle('replace');
  const result = await runBrowserTool('solve_slider', {tabId: 8731, bgSelector: '#bg', pieceSelector: '#piece',
    sliderSelector: '#rail', maxAttempts: 1, humanize: {overshoot: false, noise: false, releaseJitter: false}}) as any;
  expect(result).toMatchObject({ok: false, requiresUser: true, attempts: [{state: 'gone'}]});
  expect(state().released).toBe(true);
});

test('solve_slider requires an explicit boolean pass, not HTTP 200 or code=0', async () => {
  const {mouse} = puzzle('replace');
  const chrome = globals.chrome;
  const listeners = new Set<Function>();
  chrome.debugger.onEvent = {addListener: (fn: Function) => listeners.add(fn), removeListener: (fn: Function) => listeners.delete(fn)};
  const send = chrome.debugger.sendCommand;
  chrome.debugger.sendCommand = async (target: any, name: string, params: any) => {
    if (name === 'Network.getResponseBody') return {body: JSON.stringify({code: 0, message: 'OK'})};
    const response = await send(target, name, params);
    if (name === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      for (const fn of listeners) fn({tabId: 8731}, 'Network.responseReceived',
        {requestId: 'check-1', response: {url: 'https://example.test/captcha/check', status: 200}});
    }
    return response;
  };
  const result = await runBrowserTool('solve_slider', {tabId: 8731, bgSelector: '#bg', pieceSelector: '#piece',
    sliderSelector: '#rail', checkUrlContains: '/captcha/check', maxAttempts: 1,
    humanize: {overshoot: false, noise: false, releaseJitter: false}}) as any;
  expect(mouse.at(-1).type).toBe('mouseReleased');
  expect(result).toMatchObject({ok: false, attempts: [{check: {verdict: 'unknown'}}]});
});

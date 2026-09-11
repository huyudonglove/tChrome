import {afterEach, expect, test} from 'bun:test';
import {inspectCaptchaFrame, runCaptchaTool} from './captcha.js';
const globals = globalThis as any;
const originals = {chrome: globals.chrome, document: globals.document, location: globals.location, getComputedStyle: globals.getComputedStyle};
afterEach(() => { Object.assign(globals, originals); });
const frame = (result: any, frameId = 0) => ({frameId, result});
const challenge = {present: true, types: ['recaptcha'], responseCount: 0, completedResponses: 0, widgetCount: 1, widgetFrame: false, clickable: false};

test('captcha iframe detection is not a solved signal and never clicks iframe or nearby checkbox', () => {
  globals.location = {href: 'https://example.test'};
  globals.document = {
    querySelectorAll: (selector: string) => selector === 'iframe' ? [{src: 'https://google.com/recaptcha/api2/anchor', click: () => {throw Error('must not click iframe');}}] : [],
    querySelector: () => null,
  };
  expect(inspectCaptchaFrame(true, Date.now() + 1000)).toEqual({...challenge, clicked: false});
});

test('captcha wait timeout and missing target retain ok=false', async () => {
  globals.chrome = {scripting: {executeScript: async () => [frame({present: false, types: [], responseCount: 0, completedResponses: 0, widgetCount: 1, widgetFrame: false, clickable: false})]}};
  expect(await runCaptchaTool('wait_captcha', 1, {timeoutMs: 10})).toMatchObject({ok: false, present: false});
  expect(await runCaptchaTool('click_captcha', 1)).toMatchObject({ok: false, clicked: false});
});

test('captcha solve targets actual frame then waits for verified state', async () => {
  let clicked = false;
  globals.chrome = {scripting: {executeScript: async (options: any) => {
    if (options.args[0]) {
      expect(options.target).toEqual({tabId: 5, frameIds: [9]});
      clicked = true;
      return [frame({...challenge, clicked: true}, 9)];
    }
    return [frame({...challenge, responseCount: 1, completedResponses: clicked ? 1 : 0, clickable: !clicked}, 9)];
  }}};
  expect(await runCaptchaTool('solve_captcha', 5, {timeoutMs: 100})).toMatchObject({ok: true, status: 'solved', clicked: true});
});

test('captcha iframe without accessible checkbox requires user and cannot claim solved', async () => {
  globals.chrome = {scripting: {executeScript: async () => [frame(challenge)]}};
  expect(await runCaptchaTool('click_captcha', 1)).toMatchObject({ok: false, requiresUser: true, clicked: false});
  expect(await runCaptchaTool('solve_captcha', 1, {timeoutMs: 10})).toMatchObject({ok: false, requiresUser: true, status: 'challenge'});
});

test('restricted frame fallback preserves top-level detection and hangs are bounded', async () => {
  globals.chrome = {scripting: {executeScript: async (options: any) => {
    if (options.target.allFrames) throw Error('Cannot access child frame');
    return [frame(challenge)];
  }}};
  expect(await runCaptchaTool('see_captcha', 1)).toMatchObject({ok: true, partial: true, status: 'challenge'});
  globals.chrome.scripting.executeScript = () => new Promise(() => {});
  expect(await runCaptchaTool('solve_captcha', 1, {timeoutMs: 10})).toMatchObject({ok: false, requiresUser: true});
});

test('captcha response fields verify completion without returning their token', () => {
  const secret = 'test-only-response-token';
  globals.location = {href: 'https://example.test'};
  globals.document = {
    querySelectorAll: (selector: string) => selector === '[name="g-recaptcha-response"]' ? [{value: secret}] : [],
    querySelector: () => null,
  };
  const result = inspectCaptchaFrame(false, Date.now() + 1000);
  expect(result).toMatchObject({present: true, responseCount: 1, completedResponses: 1});
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('one completed response cannot hide another pending widget or response', async () => {
  for (const results of [
    [frame({...challenge, responseCount: 2, completedResponses: 1})],
    [frame({...challenge, responseCount: 1, completedResponses: 1, widgetCount: 2})],
    [frame({...challenge, responseCount: 1, completedResponses: 1}), frame({...challenge, types: ['turnstile']}, 2)],
    [frame({...challenge, responseCount: 1, completedResponses: 1, widgetFrame: true}), frame({...challenge, widgetFrame: true}, 2)],
  ]) {
    globals.chrome = {scripting: {executeScript: async () => results}};
    expect(await runCaptchaTool('solve_captcha', 1)).toMatchObject({ok: false, ambiguous: true, requiresUser: true, status: 'challenge'});
  }
});

test('checked checkbox without response token does not verify captcha completion', async () => {
  globals.location = {href: 'https://google.com/recaptcha/api2/anchor'};
  globals.getComputedStyle = () => ({visibility: 'visible'});
  globals.document = {
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector === '#recaptcha-anchor' ? {checked: true, getClientRects: () => [1], getAttribute: () => null} : null,
  };
  const observed = inspectCaptchaFrame(false, Date.now() + 100);
  globals.chrome = {scripting: {executeScript: async () => [frame(observed)]}};
  expect(await runCaptchaTool('solve_captcha', 1, {timeoutMs: 5})).toMatchObject({ok: false, status: 'challenge', requiresUser: true});
});

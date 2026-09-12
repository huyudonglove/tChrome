import { idPrefix } from '../../service/identity/catalog.ts';

const STORAGE_KEY = 'tchrome-browser-id-counters';
const kinds = new Set(['elementRef', 'pageElement', 'pageRegion']);

// One worker owns the persistent high water marks for every tab and document.
export function createBrowserIdAllocator(storage) {
  let pending = Promise.resolve();
  return (kind) => {
    if (!kinds.has(kind)) return Promise.reject(new Error('未知浏览器编号类型'));
    const allocated = pending.then(async () => {
      const counters = (await storage.get(STORAGE_KEY))[STORAGE_KEY] ?? {};
      const next = (counters[kind] ?? 0) + 1;
      if (!Number.isSafeInteger(next) || next < 1) throw new Error('浏览器编号计数器无效');
      await storage.set({[STORAGE_KEY]: {...counters, [kind]: next}});
      return `${idPrefix(kind)}${String(next).padStart(2, '0')}`;
    });
    pending = allocated.then(() => {}, () => {});
    return allocated;
  };
}

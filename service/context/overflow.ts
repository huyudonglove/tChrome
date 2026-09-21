import {createHash, randomUUID} from 'node:crypto';
import {linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {runtimeConfig} from '../config/runtime.ts';

export const CONTEXT_INLINE_CHARS = runtimeConfig.context.externalizeAtChars;

export class ContextBudgetError extends Error {
  override name = 'ContextBudgetError';
}

function exists(path: string) {
  try { return lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function store(root: string, path: string, content: string) {
  mkdirSync(root, {recursive: true});
  const directory = lstatSync(root);
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('Context files root must be an ordinary directory');
  const verify = () => {
    const file = lstatSync(path);
    if (file.isSymbolicLink() || !file.isFile() || readFileSync(path, 'utf8') !== content) {
      throw new Error(`Context file conflicts with stored content: ${path}`);
    }
  };
  if (exists(path)) { verify(); return; }
  const temporary = join(root, `.pending-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, {flag: 'wx', mode: 0o600});
    // Linking publishes complete bytes without replacing an existing destination.
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    verify();
  } finally {
    if (exists(temporary)) unlinkSync(temporary);
  }
}

/** Replace oversized rendered slot bodies with lossless, durable file references. */
export function externalizeContext({dataDir, slots, measure}: {
  dataDir: string;
  slots: Record<string, string>;
  measure: (slots: Record<string, string>) => number;
}): Record<string, string> {
  const result = {...slots};
  let size = measure(result);
  if (size <= CONTEXT_INLINE_CHARS) return result;
  const root = resolve(dataDir, 'context-files');
  const referenceFor = (content: string, format: 'json' | 'text') => {
    const path = join(root, `${createHash('sha256').update(content).digest('hex')}.${format === 'json' ? 'json' : 'txt'}`);
    return {path, value: {contextFile: {path, chars: content.length, format}}};
  };
  const isReference = (value: unknown): boolean => !!value && typeof value === 'object' && 'contextFile' in value;
  const completed = new Set<string>();
  while (size > CONTEXT_INLINE_CHARS) {
    const candidates: {key: string; content: string; path: string; replacement: string; size: number; whole: boolean}[] = [];
    for (const [key, body] of Object.entries(result)) {
      if (key === '#tools' || key === '#skill' || completed.has(key)) continue;
      let parsed: unknown;
      let format: 'json' | 'text' = 'text';
      try { parsed = JSON.parse(body); format = 'json'; } catch { /* Plain slot text stays text. */ }
      if (isReference(parsed)) continue;
      const add = (content: string, replacement: string, path: string, whole: boolean) => {
        const nextSize = measure({...result, [key]: replacement});
        if (nextSize < size) candidates.push({key, content, path, replacement, size: nextSize, whole});
      };
      const before = candidates.length;
      if (Array.isArray(parsed)) {
        parsed.forEach((item, index) => {
          if (isReference(item)) return;
          const content = JSON.stringify(item);
          const reference = referenceFor(content, 'json');
          const items = [...parsed];
          items[index] = reference.value;
          add(content, JSON.stringify(items), reference.path, false);
        });
      }
      // Keep small, recent array records visible while larger records can still be moved.
      if (candidates.length === before) {
        const reference = referenceFor(body, format);
        const replacement = JSON.stringify(reference.value);
        add(body, replacement, reference.path, true);
      }
    }
    // Release notes first; preserve the current request until other content is exhausted.
    const priority = (key: string) => key === '#notes' ? 0 : key === '#userInput' ? 2 : 1;
    candidates.sort((a, b) => priority(a.key) - priority(b.key) || a.size - b.size);
    const selected = candidates[0];
    if (!selected) throw new ContextBudgetError(`Context inline budget exceeded: ${size} characters remain; limit is ${CONTEXT_INLINE_CHARS}, and no remaining slot can be externalized`);
    store(root, selected.path, selected.content);
    result[selected.key] = selected.replacement;
    size = selected.size;
    if (selected.whole) completed.add(selected.key);
  }
  return result;
}

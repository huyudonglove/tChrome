import { AppError, errorInfo } from "../../shared/errors.ts";
import { lstat, readdir, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export const filenamePattern = '^[A-Za-z0-9][A-Za-z0-9._-]*\\.(?:js|mjs|cjs|sh|py)$';
const validName = (name: unknown): name is string => typeof name === 'string' && new RegExp(filenamePattern).test(name);
const locks = new Map<string, Promise<unknown>>();
const stat = async (path: string) => lstat(path).catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
const directory = async (dataDir: string, create = true) => {
  const path = join(resolve(dataDir), 'scripts');
  if (create) await mkdir(path, {recursive: true});
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('scripts 必须是普通目录');
  return path;
};
const regular = async (path: string) => {
  const info = await stat(path);
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('脚本必须是普通文件');
  return info;
};
export async function readScript(dataDir: string, filename: unknown): Promise<{filename: string; path: string; code: string}> {
  if (!validName(filename)) throw new AppError('invalid_arguments', '脚本文件名无效');
  const path = join(await directory(dataDir, false), filename);
  const info = await regular(path);
  if (!info) throw new AppError('file_not_found', '脚本不存在', {path});
  return {filename, path, code: await readFile(path, 'utf8')};
}
export async function listScripts(dataDir: string): Promise<{filename: string; bytes: number}[]> {
  let dir: string;
  try { dir = await directory(dataDir, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const result: {filename: string; bytes: number}[] = [];
  for (const filename of await readdir(dir)) {
    if (!validName(filename)) continue;
    const info = await stat(join(dir, filename));
    if (info?.isFile() && !info.isSymbolicLink()) result.push({filename, bytes: info.size});
  }
  return result.sort((a, b) => a.filename.localeCompare(b.filename));
}
const git = async (cwd: string, args: string[], patch?: string) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const proc = Bun.spawn(['git', ...args], {cwd, env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'},
    stdin: patch === undefined ? 'ignore' : new Blob([patch]), stdout: 'pipe', stderr: 'pipe'});
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(err.trim() || '补丁无效');
  return out;
};

export async function patchScript(dataDir: string, input: {filename?: unknown; patch?: unknown}): Promise<Record<string, unknown>> {
  const key = resolve(dataDir);
  const previous = locks.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    let scratch: string | undefined;
    let staging: string | undefined;
    try {
      const {filename, patch} = input;
      if (!validName(filename)) throw new Error('脚本文件名无效');
      if (typeof patch !== 'string' || !patch.trim()) throw new Error('需要有效 unified diff');
      // Metadata is checked separately; git owns hunk parsing and application.
      if (/^(?:rename |copy |old mode |new mode |new file mode (?!100644$)|deleted file mode (?!100644$))/m.test(patch)) throw new Error('不允许重命名、复制或文件权限变更');
      scratch = await mkdtemp(join(tmpdir(), 'tchrome-script-'));
      await git(scratch, ['init', '--quiet']);
      const counts = await git(scratch, ['apply', '--numstat', '-z', '-'], patch);
      const records = counts.split('\0').filter(Boolean);
      if (records.length !== 1 || !/^\d+\t\d+\t/.test(records[0]!) || records[0]!.split('\t').slice(2).join('\t') !== filename) throw new Error('补丁只能修改指定脚本文件');
      const dir = await directory(dataDir);
      const path = join(dir, filename);
      const info = await regular(path);
      const original = info ? await readFile(path) : null;
      if (original) await writeFile(join(scratch, filename), original, {mode: 0o644});
      await git(scratch, ['apply', '--check', '-'], patch);
      await git(scratch, ['apply', '-'], patch);
      const resultPath = join(scratch, filename);
      const result = await regular(resultPath);
      // Refuse changes made outside the serialized patch API while git ran.
      await regular(path);
      const current = await stat(path) ? await readFile(path) : null;
      if ((original === null) !== (current === null) || (original && !original.equals(current!))) throw new Error('脚本已被其他操作修改，请重新读取');
      if (!result) {
        if (!original) throw new Error('脚本不存在');
        await rm(path);
        return {ok: true, filename, operation: 'deleted', bytes: 0};
      }
      staging = await mkdtemp(join(dir, '.patch-'));
      const next = join(staging, filename);
      const code = await readFile(resultPath, 'utf8');
      await writeFile(next, code, {mode: 0o600});
      await rename(next, path);
      return {ok: true, filename, operation: original === null ? 'created' : 'updated', bytes: Buffer.byteLength(code, 'utf8')};
    } catch (error) { return {ok: false, ...errorInfo(error), error: error instanceof Error ? error.message : String(error)}; }
    finally {
      if (scratch) await rm(scratch, {recursive: true, force: true}).catch(() => {});
      if (staging) await rm(staging, {recursive: true, force: true}).catch(() => {});
    }
  });
  locks.set(key, operation);
  try { return await operation; } finally { if (locks.get(key) === operation) locks.delete(key); }
}

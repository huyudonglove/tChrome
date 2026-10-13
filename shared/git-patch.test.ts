import {expect, test} from 'bun:test';
import {normalizeGitPatch} from './git-patch.ts';

const boundary = (path = 'file.txt', indent = ' ') => [
  `${indent}diff --git a/${path} b/${path}`,
  'index 123abcd..456abcd 100644',
  `--- a/${path}`, `+++ b/${path}`,
  '@@ -1,2 +1,2 @@', '-old', '+new', ' keep', '',
].join('\n');

test('repairs only corroborated diff boundaries and reports original one-based lines', () => {
  const first = boundary('first.txt', '');
  const second = boundary('second file.txt', ' \t');
  const patch = first + second;
  expect(normalizeGitPatch(patch)).toEqual({
    patch: first + boundary('second file.txt', ''),
    normalization: {kind: 'diff_git_header_indent', lines: [first.split('\n').length]},
  });
  const fixed = normalizeGitPatch(patch).patch;
  expect(normalizeGitPatch(fixed)).toEqual({patch: fixed});
});

test('preserves CRLF and supports quoted paths, creation and deletion headers', () => {
  const quoted = boundary('file.txt', '\t')
    .replace('a/file.txt b/file.txt', '"a/file.txt" "b/file.txt"')
    .replace('--- a/file.txt', '--- "a/file.txt"')
    .replace('+++ b/file.txt', '+++ "b/file.txt"')
    .replaceAll('\n', '\r\n');
  expect(normalizeGitPatch(quoted).patch).toBe(quoted.slice(1));
  for (const created of [true, false]) {
    const patch = [
      '  diff --git a/file.txt b/file.txt',
      `${created ? 'new' : 'deleted'} file mode 100644`,
      created ? '--- /dev/null' : '--- a/file.txt',
      created ? '+++ b/file.txt' : '+++ /dev/null',
      created ? '@@ -0,0 +1 @@' : '@@ -1 +0,0 @@',
      created ? '+new' : '-old', '',
    ].join('\n');
    expect(normalizeGitPatch(patch)).toEqual({
      patch: patch.slice(2), normalization: {kind: 'diff_git_header_indent', lines: [1]},
    });
  }
});

test('does not trim source context, additions, ambiguous or unsupported file boundaries', () => {
  const valid = boundary();
  for (const patch of [
    boundary('file.txt', ''),
    valid.replace('--- a/file.txt', '--- a/other.txt'),
    valid.replace('+++ b/file.txt', '+++ b/other.txt'),
    valid.replace('@@ -1,2 +1,2 @@', '@@'),
    valid.replace('index 123abcd..456abcd 100644', 'unsupported metadata'),
    ' diff --git a/file.txt b/file.txt\n ordinary source\n',
    ' diff --git a/file.txt b/file.txt\n --- a/file.txt\n +++ b/file.txt\n @@ -1 +1 @@\n',
    '+diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n',
  ]) expect(normalizeGitPatch(patch)).toEqual({patch});
});

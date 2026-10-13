/** Diagnose failed checks only; Git remains the authority on accepted patches. */
export function describeGitPatchFailure(patch: string, message: string): string {
  if (/patch with only garbage|corrupt patch|unrecognized input|No valid patches/i.test(message)) {
    return `${message}\n补丁格式无效：检查完整的 diff 文件头、形如 @@ -1,1 +1,1 @@ 的块头及每行前缀；不要使用裸 @@。`;
  }
  if (!/patch does not apply/i.test(message)) return message;

  const missingContext: string[] = [];
  let oldFile = '';
  let newFile = '';
  let hunk: {header: string; context: boolean; changed: boolean} | undefined;
  const finish = () => {
    if (hunk && hunk.changed && !hunk.context && oldFile && newFile
      && oldFile !== '/dev/null' && newFile !== '/dev/null') {
      missingContext.push(`${newFile} ${hunk.header}`);
    }
    hunk = undefined;
  };
  const lines = patch.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      finish();
      oldFile = '';
      newFile = '';
    } else if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      finish();
      oldFile = line.slice(4).split('\t')[0]!;
      newFile = lines[++i]!.slice(4).split('\t')[0]!;
    } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      finish();
      hunk = {header: line, context: false, changed: false};
    } else if (hunk && line.startsWith(' ')) {
      hunk.context = true;
    } else if (hunk && (line.startsWith('+') || line.startsWith('-'))) {
      hunk.changed = true;
    }
  }
  finish();
  if (missingContext.length) {
    return `${message}\n补丁含缺少上下文行的修改块：${missingContext.slice(0, 3).join('；')}。`
      + '当前使用 Git 默认检查，未启用 --unidiff-zero；--recount 只重算行数，不会放宽上下文检查。'
      + '请在修改块前后补上未修改的原文行（以空格开头），不要只调整 @@ 行号；同时核对删除行与当前原文是否一致。'
      + '新增或删除整个文件使用 /dev/null，不需要上下文行。';
  }
  return `${message}\n补丁上下文不匹配：重新读取当前文件并核对块中的所有空行和上下文行；不要仅调整 @@ 行号。`;
}

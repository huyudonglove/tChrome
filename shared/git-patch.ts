/** Diagnose failed checks only; Git remains the authority on accepted patches. */
export function describeGitPatchFailure(patch: string, message: string): string {
  if (/patch with only garbage|corrupt patch|unrecognized input|No valid patches/i.test(message)) {
    return `${message}\n补丁格式无效：检查完整的 diff 文件头、形如 @@ -1,1 +1,1 @@ 的块头及每行前缀；不要使用裸 @@。`;
  }
  if (!/patch does not apply/i.test(message)) return message;

  const missingContext: string[] = [];
  const missingTrailingContext: string[] = [];
  let oldFile = '';
  let newFile = '';
  let hunk: {header: string; context: boolean; changed: boolean; endsWithChange: boolean} | undefined;
  const finish = () => {
    if (hunk && hunk.changed && oldFile && newFile
      && oldFile !== '/dev/null' && newFile !== '/dev/null') {
      if (!hunk.context) missingContext.push(`${newFile} ${hunk.header}`);
      else if (hunk.endsWithChange) missingTrailingContext.push(`${newFile} ${hunk.header}`);
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
      hunk = {header: line, context: false, changed: false, endsWithChange: false};
    } else if (hunk && line.startsWith(' ')) {
      hunk.context = true;
      hunk.endsWithChange = false;
    } else if (hunk && (line.startsWith('+') || line.startsWith('-'))) {
      hunk.changed = true;
      hunk.endsWithChange = true;
    }
  }
  finish();
  if (missingContext.length) {
    return `${message}\n补丁含缺少上下文行的修改块：${missingContext.slice(0, 3).join('；')}。`
      + '当前使用 Git 默认检查，未启用 --unidiff-zero；--recount 只重算行数，不会放宽上下文检查。'
      + '请在修改块前后补上未修改的原文行（以空格开头），不要只调整 @@ 行号；同时核对删除行与当前原文是否一致。'
      + '新增或删除整个文件使用 /dev/null，不需要上下文行。';
  }
  if (missingTrailingContext.length) {
    return `${message}\n补丁上下文不匹配：以下修改块以增删行结尾，可能缺少块尾上下文：${missingTrailingContext.slice(0, 3).join('；')}。`
      + '若修改没有到文件末尾，请补上紧接着的未修改原文行（以空格开头），不要仅调整 @@ 行号。'
      + '真正修改到文件末尾可不带块尾上下文；此时应核对删除行、空行及已有上下文是否与当前文件一致。'
      + '此提示仅帮助定位原因，不放宽 Git 检查，也不单凭块尾增删行判定补丁非法。';
  }
  return `${message}\n补丁上下文不匹配：先检查修改块前后是否保留了未修改的原文行，再核对删除行、空行和上下文与当前文件是否一致；需要时重新读取对应范围，不要仅调整 @@ 行号。`;
}

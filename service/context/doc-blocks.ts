// docs/examples 同步脚本用的围栏块替换。
// 旧实现用 /^```\n<tag>\n[\s\S]*?^```/m 匹配围栏块，但块正文里本身含 ``` 围栏（技能正文里的代码示例），
// 非贪婪匹配只替换块头、把旧尾巴留在原地，每跑一次文档就长一整段（不幂等）。
// 纯奇偶配对也不成立：文档里嵌套围栏既可能是开启行也可能是闭合行。
// 这里改为「块首精确定位 + 按围栏栈求块尾」：块首是「围栏行的下一行正好等于内容行」，
// 之后带 info string 的围栏（```html / ```json）是嵌套开启行，裸 ``` 是闭合行，
// 栈空时的那一行就是外层块尾。找不到块首或块尾未闭合都抛错，避免静默写坏文档。
export function fence(lang: string, body: string) {
  return "```" + lang + "\n" + body + "\n```";
}

function isFence(line: string): boolean {
  return line.startsWith("```");
}

// 带 info string 的围栏只能开启，不能闭合。
function isFenceOpen(line: string): boolean {
  return line.slice(3).trim().length > 0;
}

// 块首：围栏行的下一行正好是 contentLine。
function blockOpen(lines: string[], contentLine: string): number {
  for (let i = 0; i + 1 < lines.length; i++) {
    if (isFence(lines[i]) && lines[i + 1] === contentLine) return i;
  }
  return -1;
}

// 从 openIndex 起按围栏栈求外层块尾；未闭合返回 -1。
function blockClose(lines: string[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (!isFence(lines[i])) continue;
    if (isFenceOpen(lines[i])) {
      depth++;
      continue;
    }
    if (depth === 0) return i;
    depth--;
  }
  return -1;
}

// 用 body 整体替换「首个内容行为 contentLine 的围栏块」内部内容，保留外层围栏行。
// body 应是完整正文（自带 <tag> 开闭标签）。
export function replaceFencedBlock(text: string, contentLine: string, body: string): string {
  const lines = text.split("\n");
  const open = blockOpen(lines, contentLine);
  if (open < 0) throw new Error("no fenced block whose first content line is " + contentLine);
  const close = blockClose(lines, open);
  if (close < 0) throw new Error("unpaired fence after " + contentLine);
  return [...lines.slice(0, open + 1), ...body.split("\n"), ...lines.slice(close)].join("\n");
}

// 用 body 替换「首个以 headPrefix 开头的行」到「其后首个以 endPrefix 开头的行（含）」之间的内容；
// endPrefix 省略时替换到文末。任一锚点找不到就原样返回，不改文档。
export function replaceFencedSection(text: string, headPrefix: string, body: string, endPrefix?: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex(line => line.startsWith(headPrefix));
  if (start < 0) return text;
  let end = lines.length;
  if (endPrefix !== undefined) {
    const next = lines.findIndex((line, i) => i > start && line.startsWith(endPrefix));
    if (next < 0) return text;
    end = next;
  }
  return [...lines.slice(0, start), ...body.split("\n"), ...lines.slice(end)].join("\n");
}

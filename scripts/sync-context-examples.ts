import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadContextModules } from "../service/context/modules.ts";
import { fence, replaceFencedBlock, replaceFencedSection } from "../service/context/doc-blocks.ts";
import { loadToolRegistry, toolSchemas, toolGuideFor } from "../service/tools/registry.ts";
import { systemText, userText } from "../service/context/window.ts";
import { emptyLedger } from "../service/runtime/store.ts";
import { loadSkills, skillGuide } from "../service/skills/loader.ts";
import { compressionSystemPrompt } from "../service/agents/compression/protocol.ts";
import type { Turn } from "../service/types.ts";

const root = join(import.meta.dir, "..");
const c = loadContextModules(root);
const registry = loadToolRegistry(root);
// --check：只比对不写盘，文档与当前渲染结果不一致时退出 1 并列出文件。用于把本脚本挂进 bun run check。
const checkOnly = process.argv.includes("--check");
const stale: string[] = [];
function emit(path: string, text: string) {
  if (checkOnly) {
    if (readFileSync(path, "utf8") !== text) stale.push(path);
    return;
  }
  writeFileSync(path, text);
}
function update(value: any): any {
  if (!value || typeof value !== "object") return value;
  if (value.type === "function" && value.function?.name && value.function.parameters) return toolSchemas(registry, [value.function.name])[0];
  if (Array.isArray(value)) return value.map(update);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    key === "baseToolsIds" && Array.isArray(item) ? [...registry.toolGroups.baseToolsIds]
      : key === "systemSlots" && Array.isArray(item) ? [...c.systemOrder]
      : key === "userSlots" && Array.isArray(item) ? [...c.userOrder]
        : update(item),
  ]));
}
function xmlBlock(source: string, tag: string, fromIndex = 0) {
  const open = "<" + tag + ">";
  const close = "</" + tag + ">";
  const start = source.indexOf(open, fromIndex);
  const end = source.indexOf(close, start + open.length);
  if (start < 0 || end < 0) throw new Error("missing <" + tag + ">");
  return { text: source.slice(start, end + close.length), next: end + close.length };
}
for (const file of readdirSync(join(root, "docs/examples")).filter(f => /^0[1-8]-.*\.md$/.test(f))) {
  const path = join(root, "docs/examples", file);
  let text = readFileSync(path, "utf8");
  if (/^0[34]-/.test(file)) {
    const snapshot = JSON.parse(text.match(/^```json\n([\s\S]*?)^```/m)![1]!);
    const turn = { turnId: snapshot.turnId, input: { id: `input_${snapshot.turnId.slice(3)}`, text: snapshot.userInput, submittedAt: snapshot.submittedAt }, assembled: snapshot } as Turn;
    const ledger = emptyLedger(snapshot.conversationId);
    ledger.userInputHistory = snapshot.userInputHistory;
    const user = userText({ contextModules: c, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: loadSkills(root), toolGuide: toolGuideFor(registry, snapshot.toolIds) });
    text = replaceFencedBlock(text, "<overview>", systemText(c, "2026-09-06", toolGuideFor(registry, registry.toolGroups.baseToolsIds), {}, skillGuide(root)));
    text = replaceFencedBlock(text, "<skill>", user);
  }
  text = text.replace(/^```json\n([\s\S]*?)^```/gm, (_, body) => fence("json", JSON.stringify(update(JSON.parse(body)), null, 2)));
  emit(path, text);
}
const xml09 = join(root, "docs/examples/09-main-model-xml-sample.md");
{
  const snapshot = JSON.parse(readFileSync(join(root, "docs/examples/03-decode.md"), "utf8").match(/^```json\n([\s\S]*?)^```/m)![1]!);
  const turn = { turnId: snapshot.turnId, input: { id: `input_${snapshot.turnId.slice(3)}`, text: snapshot.userInput, submittedAt: snapshot.submittedAt }, assembled: snapshot } as Turn;
  const ledger = emptyLedger(snapshot.conversationId);
  ledger.userInputHistory = snapshot.userInputHistory;
  const system = systemText(c, "2026-09-18", toolGuideFor(registry, registry.toolGroups.baseToolsIds), {}, skillGuide(root));
  const user = userText({ contextModules: c, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: loadSkills(root), toolGuide: toolGuideFor(registry, snapshot.toolIds) });
  let text = readFileSync(xml09, "utf8");
  text = replaceFencedSection(text, "## System（", `## System（${system.length} 字符）\n\n` + fence("text", system), "## User（");
  text = replaceFencedSection(text, "## User（", `## User（${user.length} 字符）\n\n` + fence("text", user));
  emit(xml09, text);
}
const xml10 = join(root, "docs/examples/10-compression-agent-input-sample.md");
{
  const system = compressionSystemPrompt(root);
  const user = `<compressionTurns>
{
  "turns": [
    {
      "turnId": "tn_01",
      "userInput": {
        "userInput": "打开导出页并确认格式"
      },
      "stopReason": {
        "kind": "reply",
        "text": "支持 CSV"
      },
      "segment": {
        "complete": true
      }
    },
    {
      "turnId": "tn_02",
      "userInput": {
        "userInput": "记下偏好"
      },
      "memoryWrites": [
        {
          "memoryId": "mm_01",
          "text": "用户偏好 CSV"
        }
      ],
      "stopReason": {
        "kind": "reply",
        "text": "已记下"
      },
      "segment": {
        "complete": true
      }
    }
  ]
}
</compressionTurns>`;
  const parts = [
    "# 10 压缩 Agent 输入样例（全 XML）",
    "",
    "```",
    "agents/compression/context/",
    "  modules.json",
    "  system/overview.md    → <overview>",
    "  system/identity.md    → <identity>",
    "  system/role.md        → <compressionRole>",
    "  system/modules.md     → <compressionModules>",
    "  system/turns.md       → <compressionTurns>",
    "  system/output.md      → <compressionOutput>",
    "```",
    "",
    "装配：overview → identity → compressionRole → compressionModules → compressionTurns → compressionOutput",
    "",
  ];
  let cursor = 0;
  for (const [heading, tag] of [
    ["overview", "overview"],
    ["identity", "identity"],
    ["compressionRole", "compressionRole"],
    ["compressionModules", "compressionModules"],
    ["compressionTurns", "compressionTurns"],
    ["compressionOutput", "compressionOutput"],
  ] as const) {
    const block = xmlBlock(system, tag, cursor);
    cursor = block.next;
    parts.push("## " + heading, "", fence("text", block.text), "");
  }
  parts.push("## User", "", fence("text", user), "");
  emit(xml10, parts.join("\n"));
}
if (checkOnly && stale.length > 0) {
  for (const path of stale) console.error("stale: " + path.slice(root.length + 1));
  console.error("docs/examples 与当前渲染结果不一致，运行 bun run scripts/sync-context-examples.ts 同步。");
  process.exit(1);
}

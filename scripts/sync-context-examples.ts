import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadContextModules } from "../service/context/modules.ts";
import { loadToolRegistry, toolSchemas, toolGuideFor } from "../service/tools/registry.ts";
import { systemText, userText } from "../service/context/window.ts";
import { emptyLedger } from "../service/runtime/store.ts";
import { loadSkills } from "../service/skills/loader.ts";
import { compressionSystemPrompt } from "../service/agents/compression/protocol.ts";
import type { Turn } from "../service/types.ts";

const root = join(import.meta.dir, "..");
const c = loadContextModules(root);
const registry = loadToolRegistry(root);
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
function fence(lang: string, body: string) {
  return "```" + lang + "\n" + body + "\n```";
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
    text = text.replace(/^```\n<overview>\n[\s\S]*?^```/m, () => fence("", systemText(c, "2026-09-06", toolGuideFor(registry, registry.toolGroups.baseToolsIds))));
    text = text.replace(/^```\n<skill>\n[\s\S]*?^```/m, () => fence("", user));
  }
  text = text.replace(/^```json\n([\s\S]*?)^```/gm, (_, body) => fence("json", JSON.stringify(update(JSON.parse(body)), null, 2)));
  writeFileSync(path, text);
}
const xml09 = join(root, "docs/examples/09-main-model-xml-sample.md");
{
  const snapshot = JSON.parse(readFileSync(join(root, "docs/examples/03-decode.md"), "utf8").match(/^```json\n([\s\S]*?)^```/m)![1]!);
  const turn = { turnId: snapshot.turnId, input: { id: `input_${snapshot.turnId.slice(3)}`, text: snapshot.userInput, submittedAt: snapshot.submittedAt }, assembled: snapshot } as Turn;
  const ledger = emptyLedger(snapshot.conversationId);
  ledger.userInputHistory = snapshot.userInputHistory;
  const system = systemText(c, "2026-09-18", toolGuideFor(registry, registry.toolGroups.baseToolsIds));
  const user = userText({ contextModules: c, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: loadSkills(root), toolGuide: toolGuideFor(registry, snapshot.toolIds) });
  let text = readFileSync(xml09, "utf8");
  text = text.replace(/^## System（\d+ 字符）\n\n```text\n[\s\S]*?^```/m, `## System（${system.length} 字符）\n\n` + fence("text", system));
  text = text.replace(/^## User（\d+ 字符）\n\n```text\n[\s\S]*?^```/m, `## User（${user.length} 字符）\n\n` + fence("text", user));
  writeFileSync(xml09, text);
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
      "output": {
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
      "output": {
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
  writeFileSync(xml10, parts.join("\n"));
}

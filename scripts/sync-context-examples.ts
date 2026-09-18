import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadContextModules } from "../service/context/modules.ts";
import { loadToolRegistry, toolSchemas, toolGuideFor } from "../service/tools/registry.ts";
import { systemText, userText } from "../service/context/window.ts";
import { emptyLedger } from "../service/runtime/store.ts";
import { loadSkills } from "../service/skills/loader.ts";
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
// Keep the current pipeline examples synchronized with runtime schemas.
for (const file of readdirSync(join(root, "docs/examples")).filter(f => /^0[1-8]-.*\.md$/.test(f))) {
  const path = join(root, "docs/examples", file);
  let text = readFileSync(path, "utf8");
  if (/^0[34]-/.test(file)) {
    const snapshot = JSON.parse(text.match(/^```json\n([\s\S]*?)^```/m)![1]!);
    const turn = { turnId: snapshot.turnId, input: { id: `input_${snapshot.turnId.slice(3)}`, text: snapshot.userInput, submittedAt: snapshot.submittedAt }, assembled: snapshot } as Turn;
    const ledger = emptyLedger(snapshot.conversationId);
    ledger.userInputHistory = snapshot.userInputHistory;
    const user = userText({ contextModules: c, ledger, turn, memories: { project: "[]", conversation: "[]" }, skillText: loadSkills(root), toolGuide: toolGuideFor(registry, snapshot.toolIds) });
    text = text.replace(/^```\n<overview>\n[\s\S]*?^```/m, () => "```\n" + systemText(c, "2026-09-06", toolGuideFor(registry, registry.toolGroups.baseToolsIds)) + "\n```");
    text = text.replace(/^```\n<skill>\n[\s\S]*?^```/m, () => "```\n" + user + "\n```");
  }
  text = text.replace(/^```json\n([\s\S]*?)^```/gm, (_, body) => "```json\n" + JSON.stringify(update(JSON.parse(body)), null, 2) + "\n```");
  writeFileSync(path, text);
}

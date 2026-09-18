import { readFileSync } from "node:fs";
import { join } from "node:path";
import { identityRulesText } from "../identity/catalog.ts";

export type ModuleConsumer = "main" | "compression" | `subagent:${string}`;

export type ModuleRegistryEntry = {
  id: string;
  role: "system" | "user" | "archive";
  order: number;
  file: string | null;
  consumers: ModuleConsumer[];
  description?: string;
  compress?: boolean;
  archiveField?: string | null;
  coverage?: string;
  inputSemantics?: string;
};

export type ContextModule = {
  tag: string;
  capability: string;
  description?: string;
  body: string;
};

export type ContextModules = {
  overview: string;
  systemOrder: string[];
  userOrder: string[];
  systemSlots: Record<string, ContextModule>;
  userSlots: Record<string, ContextModule>;
};

export type ModuleRegistry = {
  version: number;
  modules: ModuleRegistryEntry[];
};

const DEFAULT_SEMANTICS: Record<string, string> = {
  userInput: "用户原话 {id, turnId, userInput, submittedAt}。片段可缺省，不表示用户没输入。",
  goalChanges: "目标快照数组：id、parentId、status、goal、sourceCallId、时间。",
  pageObservations: "观察数组：id/turnId/callId/batchId/tabId/type/result。type 为工具名；与 toolIO 同 callId 时两份都读。",
  memoryWrites: "会话记忆写入：memoryId、text、sourceCallId、createdAt。",
  toolIO: "工具数组：callId/batchId/name/arguments + return.{stage,totalChars,text}；超量 text 可能是 externalized 摘要。",
  queryHistory: "历史查询：queryId、sumId、module/intent、status、records；结论写入 result。",
  output: "收尾对象：kind=reply|ask|error|tool 或 null。",
};

export function loadModuleRegistry(root: string): ModuleRegistry {
  const raw = JSON.parse(readFileSync(join(root, "service/context/modules.json"), "utf8")) as ModuleRegistry;
  if (raw.version !== 1 || !Array.isArray(raw.modules) || !raw.modules.length) throw new Error("invalid module registry");
  const ids = new Set(raw.modules.map(row => row.id));
  if (ids.size !== raw.modules.length) throw new Error("duplicate module registry id");
  for (const row of raw.modules) {
    if (row.compress && !row.archiveField && row.role !== "archive") {
      // archive-only rows may use archiveField without a context file
    }
    if (row.role !== "archive" && !row.file) throw new Error(`module missing file: ${row.id}`);
  }
  return raw;
}

export function registryModules(registry: ModuleRegistry, opts: { role?: ModuleRegistryEntry["role"]; consumer?: ModuleConsumer } = {}): ModuleRegistryEntry[] {
  return registry.modules
    .filter(row => (opts.role ? row.role === opts.role : true))
    .filter(row => (opts.consumer ? row.consumers.includes(opts.consumer) : true))
    .sort((a, b) => a.order - b.order);
}

export function compressedArchiveFields(registry: ModuleRegistry): string[] {
  return registry.modules
    .filter(row => row.compress && row.archiveField)
    .map(row => row.archiveField!);
}

export function archiveFieldSemantics(entry: ModuleRegistryEntry): string {
  return entry.inputSemantics || DEFAULT_SEMANTICS[entry.archiveField!] || entry.description || entry.archiveField!;
}

/** Generated block for compression Agent system: archive fields from registry. */
export function compressionArchiveFieldsMarkdown(root: string): string {
  const registry = loadModuleRegistry(root);
  const lines = registry.modules
    .filter(row => row.compress && row.archiveField)
    .map(row => `- ${row.archiveField}: ${archiveFieldSemantics(row)}`);
  return [
    "### 注册表字段对照（modules.json compress=true）",
    "",
    ...lines,
  ].join("\n");
}

/** Parse B-style XML module: <id>能力/详细描述[/内容]</id> */
export function parseModule(text: string, expectedTag: string): ContextModule {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const match = trimmed.match(/^<([A-Za-z][A-Za-z0-9]*)>\n([\s\S]*)\n<\/\1>$/);
  if (!match) throw new Error(`invalid module format ${expectedTag}`);
  const [, tag, inner] = match;
  const want = expectedTag.startsWith("#") ? expectedTag.slice(1) : expectedTag;
  if (tag !== want) throw new Error(`module tag mismatch ${expectedTag}: ${tag}`);
  const bodyText = inner!.trim();
  const cap = bodyText.match(/^能力：([【][^\n【】]+[】])\n\s*详细描述：\n([\s\S]+)$/);
  if (!cap) throw new Error(`invalid module content ${expectedTag}`);
  const capability = cap[1]!;
  const rest = cap[2]!.trim();
  if (!capability.slice(1, -1).trim() || !rest) throw new Error(`empty module content ${expectedTag}`);
  const parts = rest.split(/\n\n内容：\n/);
  if (parts.length > 2) throw new Error(`duplicate module content section ${expectedTag}`);
  if (parts.length === 2) {
    if (!parts[0]!.trim() || !parts[1]!.trim()) throw new Error(`empty module content ${expectedTag}`);
    if (parts[0]!.includes("{{")) throw new Error(`placeholder in module description ${expectedTag}`);
    return { tag: `#${want}`, capability, description: parts[0]!.trim(), body: parts[1]!.trim() };
  }
  return { tag: `#${want}`, capability, body: rest };
}

function loadXmlModule(dir: string, entry: ModuleRegistryEntry): ContextModule {
  const path = join(dir, entry.file!);
  return parseModule(readFileSync(path, "utf8"), entry.id);
}

/** XML body for one module (B: capability + description + optional data). */
function renderXmlModule(module: ContextModule, data?: string): string {
  const id = module.tag.replace(/^#/, "");
  const head = `<${id}>\n能力：${module.capability}\n\n详细描述：\n${module.description ?? module.body}`;
  if (data === undefined) return `${head}\n</${id}>`;
  return `${head}\n\n内容：\n${data}\n</${id}>`;
}

export function renderSlots(order: string[], files: Record<string, ContextModule>, data: Record<string, string>): string {
  return order.map(tag => {
    const module = files[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    return renderXmlModule(module, data[tag] ?? "");
  }).join("\n\n");
}

/** System / compression-facing inventory: XML modules without live data sections. */
export function renderInventory(role: "System" | "User", order: string[], modules: Record<string, ContextModule>, data: Record<string, string> = {}): string {
  return order.map(tag => {
    const module = modules[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    const id = tag.replace(/^#/, "");
    const payload = data[tag] ?? (tag === "#recordIdentity" ? identityRulesText() : undefined);
    const body = payload !== undefined && payload !== "" ? payload : (role === "System" ? module.body : module.description ?? module.body);
    const head = `<${id}>\n能力：${module.capability}\n\n详细描述：\n${body}`;
    return payload !== undefined && payload !== "" && role === "System" && tag === "#baseTools"
      ? `${head}\n\n${payload}\n</${id}>`
      : payload !== undefined && payload !== "" && tag === "#recordIdentity"
        ? `${head}\n\n${payload}\n</${id}>`
        : `${head}\n</${id}>`;
  }).join("\n\n");
}

export function loadContextModules(root: string): ContextModules {
  const dir = join(root, "service", "context");
  const overview = readFileSync(join(dir, "overview.md"), "utf8").trim();
  if (!overview) throw new Error("empty context overview");
  const registry = loadModuleRegistry(root);
  const systemEntries = registryModules(registry, { role: "system", consumer: "main" });
  const userEntries = registryModules(registry, { role: "user", consumer: "main" });
  const systemOrder = systemEntries.map(row => `#${row.id}`);
  const userOrder = userEntries.map(row => `#${row.id}`);
  if (systemOrder.some(tag => userOrder.includes(tag))) throw new Error("duplicate tag across system and user");
  const systemSlots = Object.fromEntries(systemEntries.map(entry => [`#${entry.id}`, loadXmlModule(dir, entry)]));
  const userSlots = Object.fromEntries(userEntries.map(entry => [`#${entry.id}`, loadXmlModule(dir, entry)]));
  return { overview, systemOrder, userOrder, systemSlots, userSlots };
}

export function systemTextFromModules(modules: ContextModules, currentDate: string, baseToolGuide = ""): string {
  const parts = [interpolate(modules.overview, { currentDate })];
  for (const tag of modules.systemOrder) {
    const module = modules.systemSlots[tag]!;
    const id = tag.slice(1);
    const payload = tag === "#baseTools" ? baseToolGuide : tag === "#recordIdentity" ? identityRulesText() : "";
    const body = payload
      ? (module.body.includes("{{data}}")
        ? module.body.replaceAll("{{data}}", payload)
        : `${module.body}\n\n${payload}`)
      : module.body.replaceAll("{{data}}", "");
    parts.push(`<${id}>\n能力：${module.capability}\n\n详细描述：\n${body}\n</${id}>`);
  }
  return parts.join("\n\n");
}

/** Replace once: user-provided placeholder-looking text is literal data. */
export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
    const key = name.trim();
    if (!(key in slots)) throw new Error(`unknown module placeholder ${key}`);
    return slots[key]!;
  });
}

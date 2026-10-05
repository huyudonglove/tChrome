import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { identityRulesText } from "../identity/catalog.ts";
import { promptNumberSlots } from "./prompt-numbers.ts";

export type ModuleConsumer = "main" | "compression" | `subagent:${string}`;

export type ModuleRegistryEntry = {
  id: string;
  role: "system" | "user" | "archive";
  order: number;
  file: string | null;
  consumers: ModuleConsumer[];
  description?: string;
  archiveField?: string | null;
  inputSemantics?: string;
  /** Placeholder names filled from promptNumberSlots() when loading the module body. */
  inject?: string[];
};

export type ContextModule = {
  tag: string;
  /** 合并后的功能说明（原能力句 + 原详细描述）。 */
  purpose: string;
  /** 内容模板（可含 {{data}} / {{slots}}），无则为空。 */
  template: string;
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

/**
 * Data-shape hints injected with each archive module. The conversation projection
 * now renders records as attributed elements, so the hints describe attributes and
 * body rather than JSON keys.
 */
const DEFAULT_SEMANTICS: Record<string, string> = {
  userInput: "元素 `<userInput id turnId>`，正文是用户原话。片段可缺省，不表示用户没输入。",
  observations: "每条一个 `<observation id callId tabId? type taskId? taskItemId? writtenTurn? validUntilTurn?>` 元素，正文是该次观察的完整返回。type 为产生观察的工具名。与 toolIO 同 callId 时两份都读。超过自己声明的 validUntilTurn 后不再注入；跨轮仍要留的结论用 memory_writeConversation 写成会话记忆。",
  memoryWrites: "每条一个 `<memory memoryId turnId sourceCallId>` 元素，正文是记忆正文。此处只含本轮写入的会话记忆。",
  toolIO: "每条一个 `<call callId turnId name ok?>` 元素，args 是调用参数（大小超门禁时只留 files 路径），正文是返回载荷。写模块的调用（finishTurn/askUser/notes/memory/task/reflect/observation/workspace）只存指针，正文在对应模块。与 observations 同 callId 的调用返回为 `{ok, observationId}`。",
  queryHistory: "每条一个 `<query queryId turnId sumId module status sourceCallId?>` 元素，正文是 intent 与 records；命中被外置时 ok/totalChars/path 等作为属性，正文只留 summary。status 为 complete / not_found / error。",
  stopReason: "元素或缺省。`<stopReason kind callId?>` 的正文：`reply` 为最终回复正文（侧栏与后续上下文同一 text）；`ask` 在等用户；`error` 的 faultCode/causeCode/toolName/detail 作属性；`tool` 的 name/callId 作属性，停在该调用、还没收口。缺省表示暂无收尾。",
  reflection: "元素或缺省。`<reflection turnId>` 下每条 `<reflect id focus?>`，正文是反思正文。缺省表示未填写。",
};

export function loadModuleRegistry(root: string): ModuleRegistry {
  const raw = JSON.parse(readFileSync(join(root, "service/context/modules.json"), "utf8")) as ModuleRegistry;
  if (raw.version !== 1 || !Array.isArray(raw.modules) || !raw.modules.length) throw new Error("invalid module registry");
  const ids = new Set(raw.modules.map(row => row.id));
  if (ids.size !== raw.modules.length) throw new Error("duplicate module registry id");
  for (const row of raw.modules) {
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
    .filter(row => row.archiveField)
    .map(row => row.archiveField!);
}

export function archiveFieldSemantics(entry: ModuleRegistryEntry): string {
  return entry.inputSemantics || DEFAULT_SEMANTICS[entry.archiveField!] || entry.description || entry.archiveField!;
}

/** Generated block for compression Agent system: archive fields from registry. */
export function compressionArchiveFieldsMarkdown(root: string): string {
  const registry = loadModuleRegistry(root);
  const lines = registry.modules
    .filter(row => row.archiveField)
    .map(row => `- ${row.archiveField}: ${archiveFieldSemantics(row)}`);
  return lines.join("\n");
}

/** Shell fields always present on archive turn/segment objects. */
export function compressionTurnShellMarkdown(): string {
  return [
    "材料对象外层：conversationId、turnId、status、createdAt、completedAt、sequence{turn,batch}、segment{complete,batchIds?}。",
    "下列 archiveField 为该轮进入压缩的模块；不在此列表的窗口模块不进入 turns 材料。",
  ].join("\n");
}

/** Parse B-style XML module: <id>功能：[/内容]</id> */
export function parseModule(text: string, expectedTag: string): ContextModule {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const match = trimmed.match(/^<([A-Za-z][A-Za-z0-9]*)>\n([\s\S]*)\n<\/\1>$/);
  if (!match) throw new Error(`invalid module format ${expectedTag}`);
  const [, tag, inner] = match;
  const want = expectedTag.startsWith("#") ? expectedTag.slice(1) : expectedTag;
  if (tag !== want) throw new Error(`module tag mismatch ${expectedTag}: ${tag}`);
  const bodyText = inner!.trim();
  const capMatch = bodyText.match(/^功能：\n([\s\S]+)$/);
  if (!capMatch) throw new Error(`invalid module content ${expectedTag}`);
  const rest = capMatch[1]!;
  const parts = rest.split(/\n\n内容：\n/);
  if (parts.length > 2) throw new Error(`duplicate module content section ${expectedTag}`);
  const purpose = parts[0]!.trim();
  const template = (parts[1] ?? "").trim();
  if (!purpose) throw new Error(`empty module content ${expectedTag}`);
  return { tag: `#${want}`, purpose, template };
}

function loadXmlModule(dir: string, entry: ModuleRegistryEntry): ContextModule {
  const path = join(dir, entry.file!);
  const module = parseModule(readFileSync(path, "utf8"), entry.id);
  if (!entry.inject?.length) return module;
  const slots = promptNumberSlots();
  const fill = (text: string) => {
    let out = text;
    for (const key of entry.inject!) {
      const value = slots[key];
      if (value === undefined) throw new Error(`unknown prompt inject ${key} for ${entry.id}`);
      out = out.replaceAll(`{{${key}}}`, value);
    }
    return out;
  };
  const filled = {
    ...module,
    purpose: fill(module.purpose),
    template: fill(module.template),
  };
  // 拼写检查：填完还剩未知占位就是写错了（currentDate/dataDir/cwd/os/data 由后级填充）。
  for (const text of [filled.purpose, filled.template]) {
    const stray = text.match(/\{\{(\w+)\}\}/);
    if (stray && !["currentDate", "dataDir", "cwd", "os", "data"].includes(stray[1]!)) {
      throw new Error(`unresolved placeholder in module ${entry.id}`);
    }
  }
  return filled;
}

/** Attribute values are data, not markup: escape the five XML metacharacters. */
const xmlAttr = (value: string) => value
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Per-tag attribute maps: tag (with '#') -> attribute name -> value. */
export type SlotAttributes = Record<string, Record<string, string>>;

/** XML body for one module (B: 功能 + optional data). */
function renderXmlModule(module: ContextModule, data?: string, attributes?: SlotAttributes[string]): string {
  const id = module.tag.replace(/^#/, "");
  const attrs = attributes
    ? Object.entries(attributes).map(([k, v]) => ` ${k}="${xmlAttr(v)}"`).join("")
    : "";
  const head = `<${id}${attrs}>\n功能：\n${module.purpose}`;
  if (data === undefined) return `${head}\n</${id}>`;
  return `${head}\n\n内容：\n${data}\n</${id}>`;
}

export function renderSlots(
  order: string[],
  files: Record<string, ContextModule>,
  data: Record<string, string>,
  attributes: Record<string, Record<string, string>> = {},
): string {
  return order.map(tag => {
    const module = files[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    return renderXmlModule(module, data[tag] ?? "", attributes[tag]);
  }).join("\n\n");
}

/** System / compression-facing inventory: XML modules without live data sections. */
export function renderInventory(role: "System" | "User", order: string[], modules: Record<string, ContextModule>, data: Record<string, string> = {}): string {
  return order.map(tag => {
    const module = modules[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    const id = tag.replace(/^#/, "");
    const payload = data[tag] ?? (tag === "#recordIdentity" ? identityRulesText() : undefined);
    const body = payload !== undefined && payload !== "" ? payload : module.template;
    const head = `<${id}>\n功能：\n${module.purpose}`;
    return payload !== undefined && payload !== "" && role === "System" && tag === "#baseTools"
      ? `${head}\n\n${payload}\n</${id}>`
      : payload !== undefined && payload !== "" && tag === "#recordIdentity"
        ? `${head}\n\n${payload}\n</${id}>`
        : `${head}\n</${id}>`;
  }).join("\n\n");
}

export function loadContextModules(root: string): ContextModules {
  const dir = join(root, "service", "context");
  const registry = loadModuleRegistry(root);
  const systemEntries = registryModules(registry, { role: "system", consumer: "main" });
  const userEntries = registryModules(registry, { role: "user", consumer: "main" });
  const systemOrder = systemEntries.map(row => `#${row.id}`);
  const userOrder = userEntries.map(row => `#${row.id}`);
  if (systemOrder.some(tag => userOrder.includes(tag))) throw new Error("duplicate tag across system and user");
  const systemSlots = Object.fromEntries(systemEntries.map(entry => [`#${entry.id}`, loadXmlModule(dir, entry)]));
  const userSlots = Object.fromEntries(userEntries.map(entry => [`#${entry.id}`, loadXmlModule(dir, entry)]));
  const overview = systemSlots["#overview"]?.purpose ?? "";
  if (!overview) throw new Error("missing system overview module");
  return { overview, systemOrder, userOrder, systemSlots, userSlots };
}

export function hostOsLabel(platform = process.platform, arch = process.arch): string {
  const name = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : platform;
  return `${name} (${platform}/${arch})`;
}

export type ContextEnv = { cwd?: string; os?: string; dataDir?: string };

export function systemTextFromModules(
  modules: ContextModules,
  currentDate: string,
  baseToolGuide = "",
  env: ContextEnv = {},
  skillGuide = "",
): string {
  const cwd = env.cwd ?? process.cwd();
  const dataDir = env.dataDir ?? defaultDataDirLabel();
  const os = env.os ?? hostOsLabel();
  const parts: string[] = [];
  for (const tag of modules.systemOrder) {
    const module = modules.systemSlots[tag]!;
    const id = tag.slice(1);
    const extra = tag === "#baseTools" ? baseToolGuide
      : tag === "#recordIdentity" ? identityRulesText()
      : tag === "#systemSkill" ? skillGuide
      : "";
    let body = module.template.includes("{{data}}")
      ? `${module.purpose}\n\n${module.template.replaceAll("{{data}}", extra)}`
      : extra
        ? `${module.purpose}${module.template ? `\n\n${module.template}` : ""}\n\n${extra}`
        : `${module.purpose}${module.template ? `\n\n${module.template}` : ""}`;
    if (tag === "#overview") {
      body = body
        .replaceAll("{{currentDate}}", currentDate)
        .replaceAll("{{dataDir}}", dataDir)
        .replaceAll("{{cwd}}", cwd)
        .replaceAll("{{os}}", os);
    }
    parts.push(`<${id}>\n功能：\n${module.purpose}\n\n${body}\n</${id}>`);
  }
  return parts.join("\n\n");
}

/** Model-facing data root: same default as runtime store, overridable via TCHROME_DATA. */
function defaultDataDirLabel(): string {
  return process.env.TCHROME_DATA || join(homedir(), "Library", "Application Support", "tChrome");
}

/** Replace once: user-provided placeholder-looking text is literal data. */
export function interpolate(template: string, slots: Record<string, string>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, name: string) => {
    const key = name.trim();
    if (!(key in slots)) throw new Error(`unknown module placeholder ${key}`);
    return slots[key]!;
  });
}

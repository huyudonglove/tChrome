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
  /** 模块用途与职责，渲染在 <purpose> 内。 */
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

/** Field descriptions for the compression Agent's JSON input. */
const DEFAULT_SEMANTICS: Record<string, string> = {
  loops: "按时间排序的 loop 数组。id 标识交互；runtime 记录 userInput、interrupt、callsResult 和 notice；helm 保存模型回复和工具调用。调用意图不是执行事实，按 callId 关联调用与结果，提醒只适用于产生它的 loop。",
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

/** Parse an XML module with one purpose block and optional content template. */
export function parseModule(text: string, expectedTag: string): ContextModule {
  const trimmed = text.replaceAll("\r\n", "\n").trim();
  const match = trimmed.match(/^<([A-Za-z][A-Za-z0-9]*)>\n([\s\S]*)\n<\/\1>$/);
  if (!match) throw new Error(`invalid module format ${expectedTag}`);
  const [, tag, inner] = match;
  const want = expectedTag.startsWith("#") ? expectedTag.slice(1) : expectedTag;
  if (tag !== want) throw new Error(`module tag mismatch ${expectedTag}: ${tag}`);
  const bodyText = inner!.trim();
  const sections = bodyText.match(/^<purpose>\n((?:(?!<\/?purpose>)[\s\S])+)\n<\/purpose>(?:\n\n((?:(?!<\/?purpose>)[\s\S])*))?$/);
  if (!sections) throw new Error(`invalid module content ${expectedTag}`);
  const purpose = sections[1]!.trim();
  const template = (sections[2] ?? "").trim();
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

/** XML body for one module: purpose followed by optional data. */
function renderXmlModule(module: ContextModule, data?: string, attributes?: SlotAttributes[string]): string {
  const id = module.tag.replace(/^#/, "");
  const attrs = attributes
    ? Object.entries(attributes).map(([k, v]) => ` ${k}="${xmlAttr(v)}"`).join("")
    : "";
  const head = `<${id}${attrs}>\n<purpose>\n${module.purpose}\n</purpose>`;
  if (data === undefined) return `${head}\n</${id}>`;
  return `${head}\n\n${data}\n</${id}>`;
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
    const id = module.tag.replace(/^#/, "");
    const attrs = Object.entries(attributes[tag] ?? {})
      .map(([key, value]) => ` ${key}="${xmlAttr(value)}"`).join("");
    return `<${id}${attrs}>\n${data[tag] ?? ""}\n</${id}>`;
  }).join("\n\n");
}

/** System / compression-facing inventory: XML modules without live data sections. */
export function renderInventory(role: "System" | "User", order: string[], modules: Record<string, ContextModule>, data: Record<string, string> = {}): string {
  return order.map(tag => {
    const module = modules[tag];
    if (!module) throw new Error(`missing slot file ${tag}`);
    const payload = data[tag] ?? (tag === "#recordIdentity" ? identityRulesText() : undefined);
    const showPayload = payload !== undefined && payload !== "" &&
      ((role === "System" && tag === "#baseTools") || tag === "#recordIdentity");
    return renderXmlModule(module, showPayload ? payload : undefined);
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
    const extra = tag === "#baseTools" ? baseToolGuide
      : tag === "#recordIdentity" ? identityRulesText()
      : tag === "#systemSkill" ? skillGuide
      : "";
    let purpose = module.purpose;
    if (tag === "#overview") {
      purpose = purpose
        .replaceAll("{{currentDate}}", currentDate)
        .replaceAll("{{dataDir}}", dataDir)
        .replaceAll("{{cwd}}", cwd)
        .replaceAll("{{os}}", os);
    }
    const data = module.template.includes("{{data}}")
      ? module.template.replaceAll("{{data}}", extra)
      : [module.template, extra].filter(Boolean).join("\n\n");
    parts.push(renderXmlModule({ ...module, purpose }, data || undefined));
  }
  parts.push(renderInventory("User", modules.userOrder, modules.userSlots));
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

import { createProvider, type ProviderConfig } from "./uuapi.ts";
import { createGeminiProvider } from "./gemini.ts";

/** Provider 唯一入口：默认 model / baseURL / env 覆盖名只在这里登记，GUI 与运行时同源分发。 */
type ProviderRow = {
  id: string;
  label: string;
  model: string;
  baseURL?: string;
  apiKeyEnv: string;
  modelEnv: string;
  baseUrlEnv?: string;
  effortEnv?: string;
  kind?: "uuapi" | "gemini" | "openai" | "responses";
  sanitizeToolNames?: boolean;
};

export const providers: readonly ProviderRow[] = [
  { id: "uuapi", label: "UUAPI", model: "gemini-3.8-flash", apiKeyEnv: "UUAPI_API_KEY", modelEnv: "UUAPI_MODEL", kind: "uuapi" },
  { id: "shiningspace", label: "ShiningSpace", model: "grok-4.6", baseURL: "https://ai.shiningspace.com:8090/v1", apiKeyEnv: "SHININGSPACE_API_KEY", modelEnv: "SHININGSPACE_MODEL", effortEnv: "SHININGSPACE_REASONING_EFFORT", kind: "responses" },
  { id: "gemini", label: "Google Gemini", model: "gemini-3.8-flash", apiKeyEnv: "GEMINI_API_KEY", modelEnv: "GEMINI_MODEL", kind: "gemini" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-v4.1-flash", baseURL: "https://api.a6api.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", baseUrlEnv: "DEEPSEEK_BASE_URL", effortEnv: "DEEPSEEK_REASONING_EFFORT", kind: "openai" },
  { id: "caicai", label: "CaicAI", model: "DeepSeek-V4.1-Flash", baseURL: "https://www.caicaicome888.top/v1", apiKeyEnv: "CAICAI_API_KEY", modelEnv: "CAICAI_MODEL", baseUrlEnv: "CAICAI_BASE_URL", effortEnv: "CAICAI_REASONING_EFFORT", kind: "openai", sanitizeToolNames: true },
  { id: "deepseek-official", label: "DeepSeek Official", model: "deepseek-flash", baseURL: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_OFFICIAL_API_KEY", modelEnv: "DEEPSEEK_OFFICIAL_MODEL", baseUrlEnv: "DEEPSEEK_OFFICIAL_BASE_URL", effortEnv: "DEEPSEEK_OFFICIAL_REASONING_EFFORT", kind: "openai", sanitizeToolNames: true },
  { id: "xcode", label: "Xcode.best", model: "grok-4.7", baseURL: "https://xcode.best/v1", apiKeyEnv: "XCODE_API_KEY", modelEnv: "XCODE_MODEL", baseUrlEnv: "XCODE_BASE_URL", effortEnv: "XCODE_REASONING_EFFORT", kind: "openai", sanitizeToolNames: true },
] as const;

export const providerOptions = providers.map(({ id, label, model }) => ({ id, label, model }));
export type ProviderName = typeof providers[number]["id"];
export function isProviderName(value: unknown): value is ProviderName {
  return providers.some((provider) => provider.id === value);
}

export const providerApiKeyEnv: Record<string, string> = Object.fromEntries(
  providers.map((provider) => [provider.id, provider.apiKeyEnv]),
);

const rowOf = (name: string) => {
  const row = providers.find((provider) => provider.id === name);
  if (!row) throw new Error(`TCHROME_PROVIDER must be ${providers.map((p) => p.id).join(", ")}`);
  return row;
};

export function configuredProvider(proxy: string | undefined, name = Bun.env.TCHROME_PROVIDER ?? "uuapi") {
  const row = rowOf(name);
  const model = Bun.env[row.modelEnv] ?? row.model;
  const effort = (Bun.env[row.effortEnv ?? ""] ?? "medium") as ProviderConfig["reasoningEffort"];
  if (row.effortEnv && !["low", "medium", "high"].includes(effort)) {
    throw new Error(`${row.effortEnv} must be low, medium or high`);
  }
  if (row.kind === "uuapi") return createProvider({ proxy });
  if (row.kind === "gemini") return createGeminiProvider({ proxy });
  return createProvider({
    ...(row.kind === "responses" ? { api: "responses" as const } : {}),
    apiKey: Bun.env[row.apiKeyEnv] ?? "",
    baseURL: (row.baseUrlEnv ? Bun.env[row.baseUrlEnv] : undefined) ?? row.baseURL ?? "",
    model,
    reasoningEffort: effort,
    ...(row.sanitizeToolNames ? { sanitizeToolNames: true } : {}),
    proxy,
  });
}

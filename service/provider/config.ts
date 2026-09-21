import { createProvider, type ProviderConfig } from "./uuapi.ts";
import { createGeminiProvider } from "./gemini.ts";

export const providerOptions = [
  { id: "uuapi", label: "UUAPI", model: "gemini-3.8-flash" },
  { id: "shiningspace", label: "ShiningSpace", model: "grok-4.6" },
  { id: "gemini", label: "Google Gemini", model: "gemini-3.8-flash" },
  { id: "deepseek", label: "DeepSeek", model: "deepseek-v4.1-flash" },
  { id: "caicai", label: "CaicAI", model: "DeepSeek-V4.1-Flash" },
  { id: "deepseek-official", label: "DeepSeek Official", model: "deepseek-flash" },
  { id: "xcode", label: "Xcode.best", model: "deepseek-flash" },
] as const;
export type ProviderName = typeof providerOptions[number]["id"];
export function isProviderName(value: unknown): value is ProviderName {
  return providerOptions.some((provider) => provider.id === value);
}

export const providerApiKeyEnv: Record<ProviderName, string> = {
  uuapi: "UUAPI_API_KEY",
  shiningspace: "SHININGSPACE_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  caicai: "CAICAI_API_KEY",
  "deepseek-official": "DEEPSEEK_OFFICIAL_API_KEY",
  xcode: "XCODE_API_KEY",
};

export function configuredProvider(proxy: string | undefined, name = Bun.env.TCHROME_PROVIDER ?? "uuapi") {
  if (name === "uuapi") return createProvider({ proxy });
  if (name === "gemini") return createGeminiProvider({ proxy });
  if (name === "deepseek") {
    return createProvider({
      apiKey: Bun.env.DEEPSEEK_API_KEY ?? "",
      baseURL: Bun.env.DEEPSEEK_BASE_URL ?? "https://api.a6api.com/v1",
      model: Bun.env.DEEPSEEK_MODEL ?? "deepseek-v4.1-flash",
      reasoningEffort: (Bun.env.DEEPSEEK_REASONING_EFFORT ?? "medium") as ProviderConfig["reasoningEffort"],
      proxy,
    });
  }
  if (name === "caicai") {
    return createProvider({
      apiKey: Bun.env.CAICAI_API_KEY ?? "",
      baseURL: Bun.env.CAICAI_BASE_URL ?? "https://www.caicaicome888.top/v1",
      model: Bun.env.CAICAI_MODEL ?? "DeepSeek-V4.1-Flash",
      reasoningEffort: (Bun.env.CAICAI_REASONING_EFFORT ?? "medium") as ProviderConfig["reasoningEffort"],
      sanitizeToolNames: true,
      proxy,
    });
  }
  if (name === "deepseek-official") {
    return createProvider({
      apiKey: Bun.env.DEEPSEEK_OFFICIAL_API_KEY ?? "",
      baseURL: Bun.env.DEEPSEEK_OFFICIAL_BASE_URL ?? "https://api.deepseek.com/v1",
      model: Bun.env.DEEPSEEK_OFFICIAL_MODEL ?? "deepseek-flash",
      reasoningEffort: (Bun.env.DEEPSEEK_OFFICIAL_REASONING_EFFORT ?? "medium") as ProviderConfig["reasoningEffort"],
      sanitizeToolNames: true,
      proxy,
    });
  }
  if (name === "xcode") {
    return createProvider({
      apiKey: Bun.env.XCODE_API_KEY ?? "",
      baseURL: Bun.env.XCODE_BASE_URL ?? "https://xcode.best/v1",
      model: Bun.env.XCODE_MODEL ?? "deepseek-flash",
      reasoningEffort: (Bun.env.XCODE_REASONING_EFFORT ?? "medium") as ProviderConfig["reasoningEffort"],
      sanitizeToolNames: true,
      proxy,
    });
  }
  if (name !== "shiningspace") {
    throw new Error("TCHROME_PROVIDER must be uuapi, shiningspace, gemini, deepseek, caicai, deepseek-official or xcode");
  }
  const effort = Bun.env.SHININGSPACE_REASONING_EFFORT ?? "medium";
  if (!["low", "medium", "high"].includes(effort)) throw new Error("SHININGSPACE_REASONING_EFFORT must be low, medium or high");
  return createProvider({
    api: "responses",
    apiKey: Bun.env.SHININGSPACE_API_KEY ?? "",
    baseURL: "https://ai.shiningspace.com:8090/v1",
    model: "grok-4.6",
    reasoningEffort: effort as ProviderConfig["reasoningEffort"],
    proxy,
  });
}

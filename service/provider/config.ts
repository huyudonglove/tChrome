import { createProvider, type ProviderConfig } from "./uuapi.ts";
import { createGeminiProvider } from "./gemini.ts";

export const providerOptions = [
  { id: "uuapi", label: "UUAPI", model: "gemini-3.8-flash" },
  { id: "shiningspace", label: "ShiningSpace", model: "grok-4.6" },
  { id: "gemini", label: "Google Gemini", model: "gemini-3.8-flash" },
] as const;
export type ProviderName = typeof providerOptions[number]["id"];
export function isProviderName(value: unknown): value is ProviderName {
  return providerOptions.some((provider) => provider.id === value);
}

export const providerApiKeyEnv: Record<ProviderName, string> = {
  uuapi: "UUAPI_API_KEY",
  shiningspace: "SHININGSPACE_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function configuredProvider(proxy: string | undefined, name = Bun.env.TCHROME_PROVIDER ?? "uuapi") {
  if (name === "uuapi") return createProvider({ proxy });
  if (name === "gemini") return createGeminiProvider({ proxy });
  if (name !== "shiningspace") throw new Error("TCHROME_PROVIDER must be uuapi, shiningspace or gemini");
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

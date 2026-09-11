import { createProvider, type ProviderConfig } from "./uuapi.ts";

export const providerOptions = [
  { id: "uuapi", label: "UUAPI", model: "gemini-3.8-flash" },
  { id: "shiningspace", label: "ShiningSpace", model: "grok-4.6" },
] as const;
export type ProviderName = typeof providerOptions[number]["id"];
export function isProviderName(value: unknown): value is ProviderName {
  return providerOptions.some((provider) => provider.id === value);
}

export function configuredProvider(proxy: string | undefined, name = Bun.env.TCHROME_PROVIDER ?? "uuapi") {
  if (name === "uuapi") return createProvider({ proxy });
  if (name !== "shiningspace") throw new Error("TCHROME_PROVIDER must be uuapi or shiningspace");
  const effort = Bun.env.SHININGSPACE_REASONING_EFFORT ?? "high";
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

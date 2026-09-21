import { runtimeConfig } from "../config/runtime.ts";

/** Values injected into System module bodies so prompts and runtime share one source. */
export function promptNumberSlots(): Record<string, string> {
  const ctx = runtimeConfig.context;
  return {
    compressAt: String(ctx.compressAtChars),
    externalizeAt: String(ctx.externalizeAtChars),
    summaryRecompressMin: String(ctx.summaryRecompressMinActive),
    keepBatches: String(ctx.keepToolBatches),
    inlineChars: String(runtimeConfig.results.inlineChars),
    previewChars: String(runtimeConfig.results.previewChars),
    lineWidth: String(runtimeConfig.results.lineWidth),
    searchContextChars: String(runtimeConfig.results.searchContextChars),
  };
}

/** Runtime system text must contain every configured prompt number. */
export function assertPromptNumbersMatchRuntime(systemText: string): void {
  const slots = promptNumberSlots();
  for (const [key, value] of Object.entries(slots)) {
    if (!systemText.includes(value)) {
      throw new Error(`system prompt missing runtime number ${key}=${value}`);
    }
  }
}

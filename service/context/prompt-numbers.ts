import { runtimeConfig } from "../config/runtime.ts";

/** Values injected into context module bodies so prompts and runtime share one source. */
export function promptNumberSlots(): Record<string, string> {
  const ctx = runtimeConfig.context;
  return {
    compressAt: String(ctx.compressAtChars),
    hardLimitChars: String(ctx.hardLimitChars),
    summaryFoldMin: String(ctx.summaryFoldMinRows),
    keepBatches: String(ctx.keepToolBatches),
    turnRotateAt: String(ctx.turnRotateAtChars),
    maxRotations: String(ctx.maxTurnRotations),
    skillCatalogLimit: String(ctx.skillCatalogLimit),
    readOnlyPrompt: String(ctx.readOnlyPrompt),
    readOnlySecond: String(ctx.readOnlySecond),
    readOnlyHard: String(ctx.readOnlyHard),
    inlineChars: String(runtimeConfig.results.inlineChars),
    intentMaxChars: String(runtimeConfig.results.intentMaxChars),
    imageInlineBytes: String(runtimeConfig.results.imageInlineBytes),
  };
}

/** Replaces {{slot}} with the configured runtime number. Unknown slots are left intact so callers can detect them. */
export function fillPromptNumbers(text: string, slots: Record<string, string> = promptNumberSlots()): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => slots[key] ?? whole);
}

import { runtimeConfig } from "../config/runtime.ts";

/** Values injected into System module bodies so prompts and runtime share one source. */
export function promptNumberSlots(): Record<string, string> {
  const ctx = runtimeConfig.context;
  return {
    compressAt: String(ctx.compressAtChars),
    externalizeAt: String(ctx.externalizeAtChars),
    summaryRecompressMin: String(ctx.summaryRecompressMinActive),
    summaryFoldMin: String(ctx.summaryFoldMinRows),
    keepBatches: String(ctx.keepToolBatches),
    skillCatalogLimit: String(ctx.skillCatalogLimit),
    observationFirst: String(ctx.observationNudgeFirstGate),
    observationGate2: String(Math.max(ctx.observationNudgeMinGate, ctx.observationNudgeFirstGate - ctx.observationNudgeStep)),
    observationMin: String(ctx.observationNudgeMinGate),
    checkContinuePrompt: String(ctx.checkContinuePrompt),
    checkContinueHard: String(ctx.checkContinueHard),
    repeatWindow: String(ctx.repeatWindow),
    repeatDuplicateCalls: String(ctx.repeatDuplicateCalls),
    repeatDuplicateSignatures: String(ctx.repeatDuplicateSignatures),
    inlineChars: String(runtimeConfig.results.inlineChars),
    previewChars: String(runtimeConfig.results.previewChars),
    summaryChars: String(runtimeConfig.results.summaryChars),
    lineWidth: String(runtimeConfig.results.lineWidth),
    searchContextChars: String(runtimeConfig.results.searchContextChars),
    intentMaxChars: String(runtimeConfig.results.intentMaxChars),
    imageInlineBytes: String(runtimeConfig.results.imageInlineBytes),
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

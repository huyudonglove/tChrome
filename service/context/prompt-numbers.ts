import { runtimeConfig } from "../config/runtime.ts";

/** Values injected into System module bodies so prompts and runtime share one source. */
export function promptNumberSlots(): Record<string, string> {
  const ctx = runtimeConfig.context;
  return {
    compressAt: String(ctx.compressAtChars),
    hardLimitChars: String(ctx.hardLimitChars),
    summaryRecompressMin: String(ctx.summaryRecompressMinActive),
    summaryFoldMin: String(ctx.summaryFoldMinRows),
    keepBatches: String(ctx.keepToolBatches),
    turnRotateAt: String(ctx.turnRotateAtChars),
    maxRotations: String(ctx.maxTurnRotations),
    skillCatalogLimit: String(ctx.skillCatalogLimit),
    observationFirst: String(ctx.observationNudgeFirstGate),
    observationGate2: String(Math.max(ctx.observationNudgeMinGate, ctx.observationNudgeFirstGate - ctx.observationNudgeStep)),
    observationMin: String(ctx.observationNudgeMinGate),
    readOnlyPrompt: String(ctx.readOnlyPrompt),
    readOnlySecond: String(ctx.readOnlySecond),
    readOnlyGrace: String(ctx.readOnlyGrace),
    readOnlyHard: String(ctx.readOnlyHard),
    repeatWindow: String(ctx.repeatWindow),
    repeatDuplicateCalls: String(ctx.repeatDuplicateCalls),
    repeatDuplicateSignatures: String(ctx.repeatDuplicateSignatures),
    inlineChars: String(runtimeConfig.results.inlineChars),
    intentMaxChars: String(runtimeConfig.results.intentMaxChars),
    imageInlineBytes: String(runtimeConfig.results.imageInlineBytes),
  };
}

/** Replaces {{slot}} with the configured runtime number. Unknown slots are left intact so callers can detect them. */
export function fillPromptNumbers(text: string, slots: Record<string, string> = promptNumberSlots()): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => slots[key] ?? whole);
}

/** Runtime system text must contain every configured prompt number. */
export function assertPromptNumbersMatchRuntime(systemText: string): void {
  const slots = promptNumberSlots();
  // intentMaxChars is injected into tool schemas (query tools), not systemText modules
  const { intentMaxChars: _, ...systemSlots } = slots;
  for (const [key, value] of Object.entries(systemSlots)) {
    if (!systemText.includes(value)) {
      throw new Error(`system prompt missing runtime number ${key}=${value}`);
    }
  }
}

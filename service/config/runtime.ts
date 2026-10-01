import config from "./runtime.json";

const envInt = (name: string): number | undefined => {
  // Extension bundles import this module via idle-fetch; `process` only exists in Node.
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

// Tests set TCHROME_RETRY_DELAY_MS=1 via preload so retry loops stay fast.
const resolved = {
  ...config,
  network: {
    ...config.network,
    ...(envInt("TCHROME_RETRY_DELAY_MS") !== undefined ? { retryDelayMs: envInt("TCHROME_RETRY_DELAY_MS")! } : {}),
    ...(envInt("TCHROME_MAX_ATTEMPTS") !== undefined ? { maxAttempts: envInt("TCHROME_MAX_ATTEMPTS")! } : {}),
  },
};

const BASE_KEY = "contextWindowChars";

export type GateSpec =
  | { fixed: number }
  | { follow: string; ratio: number; cap?: number; floor?: number };

/**
 * Gates are declared as base * ratio (optionally capped/floored) or as a fixed
 * count, so widening the window scales the related thresholds together while
 * caps keep single-injection gates pinned. Values resolve in declaration order
 * and may reference another gate; cycles and unknown references fail fast.
 *
 * Exported so the resolution rules can be tested without mutating runtime.json.
 */
export function deriveGates(base: number, gates: Record<string, GateSpec>): Record<string, number> {
  if (!Number.isSafeInteger(base) || base <= 0) throw new Error(`Invalid runtime configuration: scale.${BASE_KEY}`);
  const gateValues: Record<string, number> = {};
  const resolving = new Set<string>();
  const resolveGate = (key: string): number => {
    const cached = gateValues[key];
    if (cached !== undefined) return cached;
    const spec = gates[key];
    if (!spec) throw new Error(`Invalid runtime configuration: gates.${key} is not declared`);
    if (resolving.has(key)) throw new Error(`Invalid runtime configuration: gates.${key} follows itself`);
    resolving.add(key);
    let value: number;
    if ("fixed" in spec) {
      value = spec.fixed;
    } else {
      const source = spec.follow === BASE_KEY ? base : resolveGate(spec.follow);
      value = Math.round(source * spec.ratio);
      if (spec.cap !== undefined) value = Math.min(value, spec.cap);
      if (spec.floor !== undefined) value = Math.max(value, spec.floor);
    }
    resolving.delete(key);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid runtime configuration: gates.${key}`);
    gateValues[key] = value;
    return value;
  };
  for (const key of Object.keys(gates)) resolveGate(key);
  return gateValues;
}

const base = config.scale.contextWindowChars;
const gates = config.gates as unknown as Record<string, GateSpec>;
const gateValues = deriveGates(base, gates);
const resolveGate = (key: string): number => {
  const value = gateValues[key];
  if (value === undefined) throw new Error(`Invalid runtime configuration: gates.${key} is not declared`);
  return value;
};

// Fail at startup instead of silently disabling a deadline with an invalid value.
for (const [group, values] of Object.entries(resolved)) {
  if (group === "scale" || group === "gates") continue;
  for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`Invalid runtime configuration: ${group}.${key}`);
  }
  Object.freeze(values);
}

const results = {
  inlineChars: resolveGate("inlineChars"),
  previewChars: resolveGate("previewChars"),
  summaryChars: resolveGate("summaryChars"),
  lineWidth: resolveGate("lineWidth"),
  searchContextChars: resolveGate("searchContextChars"),
  // intent 是给查询岗的自然语言指令，语义与「单次返回内联门禁」无关，单独一份门禁。
  intentMaxChars: resolveGate("intentMaxChars"),
  searchMaxMatches: resolveGate("searchMaxMatches"),
  imageInlineBytes: resolveGate("imageInlineBytes"),
  // 指针/记录壳的固定开销：取回窗口要给它留位，否则返回的指针本身会顶破入窗门禁。
  pointerShellReserve: resolveGate("pointerShellReserve"),
};
const context = {
  compressAtChars: resolveGate("compressAtChars"),
  externalizeAtChars: resolveGate("externalizeAtChars"),
  summaryRecompressMinActive: resolveGate("summaryRecompressMinActive"),
  // A summary level only folds into the next one once it holds more than this many rows.
  summaryFoldMinRows: resolveGate("summaryFoldMinRows"),
  // Rows folded per model call (L1→L2, and each higher level), and the level ceiling.
  foldL1ToL2Chunk: resolveGate("foldL1ToL2Chunk"),
  foldHigherChunk: resolveGate("foldHigherChunk"),
  foldMaxLevel: resolveGate("foldMaxLevel"),
  keepToolBatches: resolveGate("keepToolBatches"),
  toolioRingSize: resolveGate("toolioRingSize"),
  // How many dynamic skills the System-side catalog lists by default; the rest stay
  // reachable through skill.list (which pages over the full set).
  skillCatalogLimit: resolveGate("skillCatalogLimit"),
  // How many process-output/<procId> directories to keep; older ones are pruned on each new process.
  processOutputRetain: resolveGate("processOutputRetain"),
  // Per-turn tool-call budget: prompt checkContinue at the soft gate, force-end at the hard gate.
  checkContinuePrompt: resolveGate("checkContinuePrompt"),
  checkContinueHard: resolveGate("checkContinueHard"),
  // Nudge thresholds (repeat / actions / observation / compress-prep). Declared here so every
  // "how many rows / how many calls" threshold has one source, same as the char budgets above.
  repeatWindow: resolveGate("repeatWindow"),
  repeatCallLimit: resolveGate("repeatCallLimit"),
  repeatDuplicateCalls: resolveGate("repeatDuplicateCalls"),
  repeatDuplicateSignatures: resolveGate("repeatDuplicateSignatures"),
  repeatFaultLimit: resolveGate("repeatFaultLimit"),
  actionsNudgeEvicted: resolveGate("actionsNudgeEvicted"),
  actionsNudgeCap: resolveGate("actionsNudgeCap"),
  observationNudgeFirstGate: resolveGate("observationNudgeFirstGate"),
  observationNudgeMinGate: resolveGate("observationNudgeMinGate"),
  observationNudgeStep: resolveGate("observationNudgeStep"),
  compressNudgeHeadroom: resolveGate("compressNudgeHeadroom"),
  reflectNudgeCalls: resolveGate("reflectNudgeCalls"),
};

// Relational invariants: a mis-scaled pair must fail at startup, not at runtime.
if (!(context.externalizeAtChars > context.compressAtChars)) {
  throw new Error("Invalid runtime configuration: context.externalizeAtChars must exceed context.compressAtChars");
}
if (!(results.summaryChars <= results.inlineChars)) {
  throw new Error("Invalid runtime configuration: results.summaryChars must not exceed results.inlineChars");
}
if (!(results.previewChars <= results.summaryChars)) {
  throw new Error("Invalid runtime configuration: results.previewChars must not exceed results.summaryChars");
}
// searchContextChars is a per-window slice, so it stays below inlineChars; only
// require it to be a positive integer that the gate resolver already produced.

Object.freeze(results);
Object.freeze(context);

export const runtimeConfig = Object.freeze({
  network: resolved.network,
  sdk: resolved.sdk,
  tls: resolved.tls,
  results,
  context,
});

import type { ToolArguments } from "../types.ts";

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

/** Shared shell rescue for all providers: fences, trailing commas, structural single quotes. */
function shellCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const push = (text: string) => { if (text && !candidates.includes(text)) candidates.push(text); };
  let text = raw.trim();
  push(text);
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) {
    text = fence[1].trim();
    push(text);
  }
  const noTrail = text.replace(/,(\s*[}\]])/g, "$1");
  push(noTrail);
  // Structural single quotes only: keys after { , [ and values after :.
  const single = noTrail
    .replace(/([{,\[]\s*)'((?:\\.|[^'\\])*)'(\s*:)/g, '$1"$2"$3')
    .replace(/(:\s*)'((?:\\.|[^'\\])*)'(\s*[,}\]])/g, '$1"$2"$3');
  push(single);
  return candidates;
}

export const parseToolArguments = (raw: unknown): { ok: true; value: ToolArguments } | { ok: false; detail: string } => {
  if (raw == null || raw === "") {
    return { ok: true, value: {} as ToolArguments };
  }
  if (typeof raw === "object") {
    const object = asObject(raw);
    if (!object) return { ok: false, detail: "arguments is array" };
    return { ok: true, value: object as ToolArguments };
  }
  if (typeof raw !== "string") {
    return { ok: false, detail: `arguments is ${typeof raw}` };
  }
  for (const candidate of shellCandidates(raw)) {
    try {
      const parsed = asObject(JSON.parse(candidate));
      if (parsed) return { ok: true, value: parsed as ToolArguments };
    } catch {}
  }
  return { ok: false, detail: "Unable to parse JSON string" };
};

/** Providers sometimes JSON-encode an array field as a string. Unwrap one layer when it parses to an array. */
export function unwrapStringArrayField(args: Record<string, unknown>, field: string): void {
  const value = args[field];
  if (typeof value !== "string") return;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) args[field] = parsed;
  } catch {}
}

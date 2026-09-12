import type { ToolArguments } from "../types.ts";

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

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
  try {
    const parsed = asObject(JSON.parse(raw));
    if (parsed) return { ok: true, value: parsed as ToolArguments };
  } catch {}
  return { ok: false, detail: "Unable to parse JSON string" };
};

import type { ToolArguments } from "../types.ts";

const asObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const unwrap = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
    || (trimmed.startsWith("[") && trimmed.endsWith("]"))
    || (trimmed.startsWith("\"") && trimmed.endsWith("\""))
  ) {
    try {
      return unwrap(JSON.parse(trimmed));
    } catch {
      return value;
    }
  }
  return value;
};

const sliceObject = (raw: string): string => {
  let text = raw.trim();
  if (!text) return "{}";
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) text = fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return text.replace(/,\s*([}\]])/g, "$1");
};

const tryParse = (raw: string): Record<string, unknown> | null => {
  try {
    return asObject(unwrap(JSON.parse(raw)));
  } catch {
    return null;
  }
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
  const sliced = sliceObject(raw);
  const parsed = tryParse(raw) ?? tryParse(sliced) ?? tryParse(sliced.replaceAll("'", "\""));
  if (parsed) return { ok: true, value: parsed as ToolArguments };
  return { ok: false, detail: "Unable to parse JSON string" };
};

export const argumentChunk = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

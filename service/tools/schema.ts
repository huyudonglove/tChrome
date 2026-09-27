import Ajv, { type ErrorObject } from "ajv";
import type { ChatTool, ToolCall } from "../types.ts";
import { errorDetail } from "../../shared/error-details.ts";

const ajv = new Ajv({ allErrors: true, strict: false });

export type SchemaCheck = {
  parseOk: boolean;
  schemaOk: boolean;
  faultCode: string | null;
  missing: string[];
  badName: string;
  detail: string;
};

const allowed = (base: string[], extra: string[]) => new Set([...base, ...extra]);

// Convert scalar encodings according to the declared schema type.
function normalizeArguments(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== "object") return value;
  const spec = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown; required?: string[] };
  if (typeof value === "string") {
    if (spec.type === "boolean" && (value === "true" || value === "false")) return value === "true";
    if ((spec.type === "number" || spec.type === "integer")
      && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      const number = Number(value);
      if (Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER
        && (spec.type !== "integer" || Number.isSafeInteger(number))) return number;
    }
  }
  if (spec.type === "array" && Array.isArray(value)) {
    return value.map(item => normalizeArguments(item, spec.items));
  }
  if (spec.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, item]) => {
        const property = spec.properties?.[key] as { type?: string } | undefined;
        return item !== "" || property?.type !== "string" || (spec.required ?? []).includes(key);
      })
      .map(([key, item]) => [key, normalizeArguments(item, spec.properties?.[key])]));
  }
  return value;
}

// AJV emits branch failures before the union error. Keep each branch together:
// a missing field in one alternative is not a globally required field.
function schemaAt(schema: unknown, pointer: string): unknown {
  return pointer.replace(/^#\/?/, "").split("/").filter(Boolean).reduce<unknown>((node, key) =>
    node && typeof node === "object"
      ? (node as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")]
      : undefined, schema);
}

const requiredPath = (error: ErrorObject) => error.instancePath
  ? `${error.instancePath}/${String(error.params.missingProperty).replace(/~/g, "~0").replace(/\//g, "~1")}`
  : String(error.params.missingProperty);
const isUnion = (error: ErrorObject) => error.keyword === "anyOf" || error.keyword === "oneOf";
const withinInstance = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
const inBranch = (error: ErrorObject, union: ErrorObject) =>
  withinInstance(error.instancePath, union.instancePath)
  && error.schemaPath.startsWith(`${union.schemaPath}/`);

// Machine-readable ajv params never say what a field accepts. Spell out the declared
// boundary (type, pattern, length, range, enum) and the field's own description so a
// rejected call can be corrected from the error alone.
const clipped = (text: string, limit = 200) => text.length > limit ? `${text.slice(0, limit)}…` : text;

// ajv points schemaPath at the failing keyword (#/properties/filename/pattern, #/additionalProperties),
// while the declared boundary lives one level up. Drop the keyword segment before reading the spec.
const ownerPointer = (error: ErrorObject) => error.schemaPath.replace(/\/[^/]*$/, "");

function fieldSpec(schema: unknown, error: ErrorObject): string | null {
  const spec = schemaAt(schema, ownerPointer(error));
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return null;
  const field = spec as {
    type?: unknown; pattern?: unknown; enum?: unknown; description?: unknown;
    minimum?: unknown; maximum?: unknown; minLength?: unknown; maxLength?: unknown;
  };
  const bounds: string[] = [];
  if (typeof field.type === "string") bounds.push(`type=${field.type}`);
  if (typeof field.minimum === "number") bounds.push(`min=${field.minimum}`);
  if (typeof field.maximum === "number") bounds.push(`max=${field.maximum}`);
  if (typeof field.minLength === "number") bounds.push(`minLength=${field.minLength}`);
  if (typeof field.maxLength === "number") bounds.push(`maxLength=${field.maxLength}`);
  if (Array.isArray(field.enum)) bounds.push(`enum=${JSON.stringify(field.enum)}`);
  if (typeof field.pattern === "string") bounds.push(`pattern=${field.pattern}`);
  const tail = typeof field.description === "string" ? clipped(field.description) : "";
  if (!bounds.length && !tail) return null;
  return `${bounds.join(", ") || "no extra constraint"}${tail ? `; ${tail}` : ""}`;
}

function unknownFieldHint(schema: unknown, error: ErrorObject): string | null {
  const parent = schemaAt(schema, ownerPointer(error)) as { properties?: Record<string, unknown> } | undefined;
  const name = error.params.additionalProperty;
  if (typeof name !== "string") return null;
  const known = Object.keys(parent?.properties ?? {});
  return known.length
    ? `unknown field "${name}"; valid fields: ${known.join(", ")}`
    : `unknown field "${name}"; this object declares no fields`;
}

function validationDetails(errors: ErrorObject[], schema: unknown): { missing: string[]; detail: string } {
  const unions = errors.filter(isUnion);
  const missing = [...new Set(errors.filter(error => error.keyword === "required"
    && !unions.some(union => inBranch(error, union))).map(requiredPath))];
  const roots = unions.filter(union => !unions.some(parent => inBranch(union, parent)));
  const ordinary = errors.filter(error => !isUnion(error) && error.keyword !== "required" && error.keyword !== "if"
    && !roots.some(union => inBranch(error, union)));
  const parts = missing.length ? [`missing required: ${missing.join(", ")}`] : [];
  for (const error of ordinary) {
    const constraint = error.keyword === "not" ? schemaAt(schema, error.schemaPath) : error.params;
    const head = `${ajv.errorsText([error])}${Object.keys(constraint ?? {}).length ? `: ${JSON.stringify(constraint)}` : ""}`;
    const boundary = error.keyword === "additionalProperties"
      ? unknownFieldHint(schema, error)
      : fieldSpec(schema, error);
    parts.push(boundary ? `${head} | accepted: ${boundary}` : head);
  }
  for (const union of roots) {
    // The original schema already describes nested alternatives; do not build a second schema renderer.
    parts.push(`data${union.instancePath} must satisfy ${union.keyword === "anyOf" ? "at least one" : "exactly one"} alternative: ${JSON.stringify(schemaAt(schema, union.schemaPath))}`);
  }
  return { missing, detail: parts.join("; ") };
}

export function checkToolCalls(
  toolCalls: ToolCall[],
  tools: ChatTool[],
  baseToolsIds: string[],
  toolIds: string[],
): SchemaCheck {
  const names = allowed(baseToolsIds, toolIds);
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  if (toolCalls.some(call => call.name === "script_patch")
    && toolCalls.some(call => ["execute_javascript", "local.run", "local.process_start"].includes(call.name))) {
    return { parseOk: true, schemaOk: false, faultCode: "script_steps_separate", missing: [],
      badName: "script_patch", detail: errorDetail("script_steps_separate") };
  }
  const closers = toolCalls.filter((call) => call.name === "finishTurn" || call.name === "askUser");
  if (closers.length > 1 || (closers[0] && toolCalls.at(-1)?.name !== closers[0].name)) {
    const name = closers[0]?.name ?? "finishTurn";
    return {
      parseOk: true,
      schemaOk: false,
      faultCode: "exclusive_resident",
      missing: [],
      badName: name,
      detail: `${name} 必须是本次 tool_calls 最后一条`,
    };
  }
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call) continue;
    if (!names.has(call.name)) {
      return {
        parseOk: true,
        schemaOk: false,
        faultCode: "unknown_tool",
        missing: [],
        badName: call.name,
        detail: `${call.name} 不在 baseToolsIds + toolIds`,
      };
    }
    const schema = byName.get(call.name)?.function.parameters;
    if (!schema) continue;
    const validate = ajv.compile(schema);
    // Runtime owns execution scheduling; never accept a model-submitted override.
    const { execution: _ignored, ...bare } = call.arguments ?? {};
    const normalized = normalizeArguments(bare, schema) as ToolCall["arguments"];
    if (!validate(normalized)) {
      const { missing, detail } = validationDetails(validate.errors ?? [], schema);
      return {
        parseOk: true,
        schemaOk: false,
        faultCode: missing.length ? "missing_required" : "wrong_type",
        missing,
        badName: call.name,
        detail: `${call.name} ${detail}`,
      };
    }
    call.arguments = normalized;
  }
  return { parseOk: true, schemaOk: true, faultCode: null, missing: [], badName: "", detail: "" };
}

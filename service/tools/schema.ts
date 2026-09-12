import Ajv, { type ErrorObject } from "ajv";
import type { ChatTool, ToolCall } from "../types.ts";

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
  const spec = schema as { type?: string; properties?: Record<string, unknown>; items?: unknown };
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
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, normalizeArguments(item, spec.properties?.[key])]));
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
    parts.push(`${ajv.errorsText([error])}${Object.keys(constraint ?? {}).length ? `: ${JSON.stringify(constraint)}` : ""}`);
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
      badName: "script_patch", detail: "先单独提交 script_patch，查看写入结果后在下一次调用中执行脚本。" };
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
    const normalized = normalizeArguments(call.arguments, schema) as ToolCall["arguments"];
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

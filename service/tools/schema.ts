import Ajv from "ajv";
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

// Normalize only unambiguous scalar strings at explicitly typed schema paths.
// Do not coerce text, null, arrays, or guess which schema branch the model meant.
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
      const missing = (validate.errors ?? [])
        .filter((err: { keyword: string }) => err.keyword === "required")
        .map((err: { params: { missingProperty?: string } }) => String(err.params.missingProperty ?? ""))
        .filter(Boolean);
      if (missing.length) {
        return {
          parseOk: true,
          schemaOk: false,
          faultCode: "missing_required",
          missing,
          badName: call.name,
          detail: `${call.name} missing required: ${missing.join(", ")}`,
        };
      }
      return {
        parseOk: true,
        schemaOk: false,
        faultCode: "wrong_type",
        missing: [],
        badName: call.name,
        detail: `${call.name} ${ajv.errorsText(validate.errors)}`,
      };
    }
    call.arguments = normalized;
  }
  return { parseOk: true, schemaOk: true, faultCode: null, missing: [], badName: "", detail: "" };
}

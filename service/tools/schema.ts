import Ajv from "ajv";
import type { ChatTool, ToolCall } from "../types.ts";

const ajv = new Ajv({ allErrors: true, strict: false });

export type SchemaCheck = {
  parseOk: boolean;
  schemaOk: boolean;
  faultCode: string | null;
  missing: string[];
};

const allowed = (base: string[], extra: string[]) => new Set([...base, ...extra]);

export function checkToolCalls(
  toolCalls: ToolCall[],
  tools: ChatTool[],
  baseToolsIds: string[],
  toolIds: string[],
): SchemaCheck {
  const names = allowed(baseToolsIds, toolIds);
  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  const closers = toolCalls.filter((call) => call.name === "finishTurn" || call.name === "askUser");
  if (closers.length > 1 || (closers[0] && toolCalls.at(-1)?.name !== closers[0].name)) {
    return { parseOk: true, schemaOk: false, faultCode: "exclusive_resident", missing: [] };
  }
  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i];
    if (!call) continue;
    if (!names.has(call.name)) {
      return { parseOk: true, schemaOk: false, faultCode: "unknown_tool", missing: [] };
    }
    const schema = byName.get(call.name)?.function.parameters;
    if (!schema) continue;
    const validate = ajv.compile(schema);
    if (!validate(call.arguments)) {
      const missing = (validate.errors ?? [])
        .filter((err: { keyword: string }) => err.keyword === "required")
        .map((err: { params: { missingProperty?: string } }) => String(err.params.missingProperty ?? ""));
      if (missing.length) {
        return { parseOk: true, schemaOk: false, faultCode: "missing_required", missing };
      }
      return { parseOk: true, schemaOk: false, faultCode: "wrong_type", missing: [] };
    }
  }
  return { parseOk: true, schemaOk: true, faultCode: null, missing: [] };
}

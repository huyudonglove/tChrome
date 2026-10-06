import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadToolRegistry, toolSchemas } from "./registry.ts";
import { checkToolCalls } from "./schema.ts";
import type { ToolCall, ToolArguments } from "../types.ts";

const registry = loadToolRegistry(join(import.meta.dir, "../.."));

test("every tool exposes optional boolean call retention without a default", () => {
  for (const tool of Object.values(registry.tools)) {
    const params = tool.function.parameters as { properties: Record<string, unknown>; required?: string[] };
    expect(params.properties.keepInCalls).toMatchObject({ type: "boolean" });
    expect(params.properties.keepInCalls).not.toHaveProperty("default");
    expect(params.required ?? []).not.toContain("keepInCalls");
  }
});

test("retention is injected even when the tool has no reason parameter", () => {
  const root = mkdtempSync(join(tmpdir(), "tchrome-retention-schema-"));
  try {
    const definitions = join(root, "service/tools/definitions");
    mkdirSync(definitions, { recursive: true });
    mkdirSync(join(root, "service/skills"), { recursive: true });
    writeFileSync(join(root, "service/skills/index.json"), JSON.stringify({ residentSkillIds: [], dynamicSkillIds: [] }));
    writeFileSync(join(definitions, "index.json"), JSON.stringify({ browser: [], service: ["probe"] }));
    writeFileSync(join(definitions, "groups.json"), JSON.stringify({ baseToolsIds: [], coreToolIds: ["probe"] }));
    writeFileSync(join(definitions, "probe.json"), JSON.stringify({ type: "function", function: {
      name: "probe", description: "Probe.", parameters: { type: "object", properties: {}, additionalProperties: false },
    } }));
    const tool = loadToolRegistry(root).tools.probe!;
    expect(tool.function.parameters?.properties).toMatchObject({ keepInCalls: { type: "boolean" } });
    expect(tool.function.parameters?.properties).not.toHaveProperty("reason");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retention accepts and preserves literal booleans, leaves omission absent, and rejects other types", () => {
  const tools = toolSchemas(registry, ["finishTurn"]);
  for (const value of [true, false, undefined, "true", "false", 1, 0, null, {}]) {
    const args = { text: "完成", ...(value === undefined ? {} : { keepInCalls: value }) };
    const call: ToolCall = { id: "call_01", name: "finishTurn", arguments: args as unknown as ToolArguments };
    const check = checkToolCalls([call], tools, ["finishTurn"], []);
    expect(check.schemaOk).toBe(value === undefined || typeof value === "boolean");
    expect(call.arguments).toEqual(args as unknown as ToolArguments);
    if (value === undefined) expect(call.arguments).not.toHaveProperty("keepInCalls");
    if (!check.schemaOk) expect(check.faultCode).toBe("wrong_type");
  }
});

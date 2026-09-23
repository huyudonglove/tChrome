import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestTurnSummaries, compressionSystemPrompt, compressionUserPrompt, compressionTurnsFromUserMessage } from "./protocol.ts";
import type { CompletionResult } from "../../types.ts";
import { readdirSync, readFileSync } from "node:fs";
const dataDir = mkdtempSync(join(tmpdir(), "compression-protocol-"));
const repoRoot = resolve(import.meta.dir, "../../..");
const turn = { turnId: "tn_01", userInput: { userInput: "打开导出页" }, toolIO: [] };
const valid = (args: Record<string, unknown> = { tag: "导出", actions: "打开并读取", result: "支持 CSV" }): CompletionResult => ({
  finish: "tool_calls", content: "忽略正文",
  toolCalls: [{ id: "result", name: "submitTurnSummaries", arguments: args }],
  attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [],
});
const validMany = (items: Record<string, unknown>[]): CompletionResult => ({
  finish: "tool_calls", content: "忽略正文",
  toolCalls: items.map((args, index) => ({ id: `result_${index + 1}`, name: "submitTurnSummaries", arguments: args })),
  attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [],
});
const input = { dataDir, conversationId: "cv_01", repoRoot, turn };

test("compression system stays layered and user payload is one-turn JSON", () => {
  const system = compressionSystemPrompt(repoRoot);
  expect(system.startsWith("<overview>")).toBe(true);
  expect(system).toContain("顺序压缩");
  expect(system).toContain("<identity>");
  expect(system).toContain("<compressionRole>");
  expect(system).toContain("<compressionModules>");
  expect(system).toContain("<compressionTurns>");
  expect(system).toContain("<compressionOutput>");
  expect(system).toContain("submitTurnSummaries");
  expect(system).toContain("{tag, actions, result}");
  expect(system).toContain("一次请求通常只含一个 turn");
  expect(system).not.toContain("{{archiveFields}}");
  const user = compressionUserPrompt(repoRoot, [turn]);
  expect(user).toBe(`<compressionTurns>\n${JSON.stringify({ turns: [turn] })}\n</compressionTurns>`);
  expect(compressionTurnsFromUserMessage(user).map(row => row.turnId)).toEqual(["tn_01"]);
});

test("single-turn submission fills userRequest from the turn shell", async () => {
  const result = await requestTurnSummaries({ ...input, provider: { complete: async request => {
    expect(request.tools.map(tool => tool.function.name)).toEqual(["submitTurnSummaries"]);
    expect(request.messages[1]!.content).toBe(`<compressionTurns>\n${JSON.stringify({ turns: [turn] })}\n</compressionTurns>`);
    return valid({ tag: "导出", actions: "打开导出页", result: "支持 CSV" });
  } } });
  expect(result).toEqual([{ turnId: "tn_01", tag: "导出", userRequest: "打开导出页", actions: "打开导出页", result: "支持 CSV" }]);
});

test("one response may submit several summaries for the same turn", async () => {
  const result = await requestTurnSummaries({ ...input, provider: { complete: async () => validMany([
    { tag: "前半", actions: "读 diff", result: "确认删除 SSE" },
    { tag: "后半", actions: "跑测试", result: "通过" },
  ]) } });
  expect(result.map(row => row.turnId)).toEqual(["tn_01", "tn_01"]);
  expect(result.map(row => row.tag)).toEqual(["前半", "后半"]);
  expect(result[0]!.userRequest).toBe("打开导出页");
});

test("format errors self-repair up to three attempts for one turn", async () => {
  let calls = 0;
  const result = await requestTurnSummaries({ ...input, provider: { complete: async request => {
    calls++;
    if (calls < 3) return valid({ summaries: [{ turnId: "tn_01" }] });
    const repair = JSON.parse(request.messages.at(-1)!.content);
    expect(repair).toMatchObject({ selfRepair: true, attempt: 3 });
    expect(repair.instruction).toContain("tn_01");
    return valid();
  } } });
  expect(calls).toBe(3);
  expect(result[0]!.turnId).toBe("tn_01");
});

test("rejects array/string/object submissions after three attempts", async () => {
  for (const args of [{ summaries: [] }, { summaries: "no" }, { tag: " ", actions: "a", result: "b" }, { tag: "t", actions: "", result: "r" }, { tag: "t", actions: "a", result: "r", turnId: "tn_01" }]) {
    let calls = 0;
    await expect(requestTurnSummaries({ ...input, provider: { complete: async () => { calls++; return valid(args as Record<string, unknown>); } } })).rejects.toThrow();
    expect(calls).toBe(3);
  }
  await expect(requestTurnSummaries({ ...input, provider: { complete: async () => ({ ...valid(), finish: "stop", toolCalls: [], content: "{}" }) } })).rejects.toThrow();
});

test("logs keep request/response and provider faults", async () => {
  const conversationId = "cv_02";
  await expect(requestTurnSummaries({ ...input, conversationId, provider: { complete: async () => valid({ tag: "t", actions: true as unknown as string, result: "r" }) } })).rejects.toThrow("compression log:");
  const dir = join(dataDir, "conversations", conversationId, "agent-logs", "compression");
  const rows = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows[0].stage).toBe("start");
  expect(rows.filter(row => row.stage === "validation-error")).toHaveLength(3);
  expect(rows.at(-1).stage).toBe("error");
  await expect(requestTurnSummaries({ ...input, conversationId: "cv_03", provider: { complete: async () => { throw new Error("network unavailable"); } } })).rejects.toThrow("network unavailable");
  await expect(requestTurnSummaries({ ...input, conversationId: "cv_04", provider: { complete: async () => ({ ...valid(), finish: "error", faultCode: "provider_key_invalid" }) } }))
    .rejects.toMatchObject({ faultCode: "provider_key_invalid", message: expect.stringContaining("compression log:") });
});

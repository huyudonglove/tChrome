import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, appendProviderExchange, loadEvents, loadProviderLog } from "./store.ts";
import type { ChatMessage } from "../types.ts";

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), "tchrome-provider-log-")); roots.push(dir); return dir; };
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const exchange = (turnId: string, system: string, user: string, content: string) => ({
  turnId,
  request: { toolIds: ["finishTurn"] },
  response: { finish: "stop" as const, toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] },
  messages: [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ] satisfies ChatMessage[],
  content,
});

test("provider log stores system once by hash and keeps user in the main file", () => {
  const dataDir = root();
  const cv = "cv_01";
  const system = "<overview>stable system</overview>";
  appendProviderExchange(dataDir, cv, exchange("tn_01", system, "用户甲", "回复甲"));
  appendProviderExchange(dataDir, cv, exchange("tn_02", system, "用户乙", "回复乙"));
  const main = readFileSync(join(dataDir, "conversations", cv, "provider.md"), "utf8");
  const systemLog = readFileSync(join(dataDir, "conversations", cv, "provider-system.md"), "utf8");
  expect(main).not.toContain("### system");
  expect(main).toContain("### user");
  expect(main).toContain("用户甲");
  expect(main).toContain("用户乙");
  expect(systemLog.match(/## system /g)).toHaveLength(1);
  expect(systemLog).toContain("stable system");
  const rows = loadProviderLog(dataDir, cv);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.systemHash).toBe(rows[1]!.systemHash);
});

test("changed system text is recorded as a new hash block", () => {
  const dataDir = root();
  const cv = "cv_01";
  appendProviderExchange(dataDir, cv, exchange("tn_01", "system-v1", "u1", "r1"));
  appendProviderExchange(dataDir, cv, exchange("tn_02", "system-v2", "u2", "r2"));
  const systemLog = readFileSync(join(dataDir, "conversations", cv, "provider-system.md"), "utf8");
  expect(systemLog.match(/## system /g)).toHaveLength(2);
  expect(systemLog).toContain("system-v1");
  expect(systemLog).toContain("system-v2");
  const rows = loadProviderLog(dataDir, cv);
  expect(rows[0]!.systemHash).not.toBe(rows[1]!.systemHash);
});

test("provider.md rotates into numbered archives once past 3MB and loadProviderLog still counts outbound", () => {
  const dataDir = root();
  const cv = "cv_01";
  const conv = join(dataDir, "conversations", cv);
  mkdirSync(conv, { recursive: true });
  const pad = "x".repeat(3 * 1024 * 1024);
  writeFileSync(join(conv, "provider.md"), `## tn_00 / 1\n\n\`\`\`json\n${JSON.stringify({ at: "t", turnId: "tn_00", outbound: 1, request: { toolIds: [] }, response: { finish: "stop", toolCalls: [], attempts: 1, parseOk: true, schemaOk: true, faultCode: null, missing: [] } })}\n\`\`\`\n\n### user\n\n\`\`\`\n${pad}\n\`\`\`\n`);
  const row = appendProviderExchange(dataDir, cv, exchange("tn_01", "sys", "user-next", "done"));
  expect(row.outbound).toBe(1);
  const files = readdirSync(conv).filter((name) => /^provider(\.\d+)?\.md$/.test(name));
  expect(files.some((name) => /^provider\.\d+\.md$/.test(name))).toBe(true);
  expect(statSync(join(conv, "provider.md")).size).toBeLessThan(3 * 1024 * 1024);
  const active = readFileSync(join(conv, "provider.md"), "utf8");
  expect(active).toContain("user-next");
  const log = loadProviderLog(dataDir, cv);
  expect(log.map((item) => item.turnId)).toEqual(["tn_00", "tn_01"]);
});

test("events.jsonl rotates into numbered archives once past 3MB and loadEvents keeps order", () => {
  const dataDir = root();
  const cv = "cv_01";
  const conv = join(dataDir, "conversations", cv);
  mkdirSync(conv, { recursive: true });
  const pad = "y".repeat(3 * 1024 * 1024);
  writeFileSync(join(conv, "events.jsonl"), `${JSON.stringify({ at: "t0", kind: "session", data: { conversationId: cv, pad } })}\n`);
  appendEvent(dataDir, cv, { kind: "tool", turnId: "tn_01", data: { callId: "call_01", name: "finishTurn" } });
  expect(readdirSync(conv).some((name) => /^events\.\d+\.jsonl$/.test(name))).toBe(true);
  expect(statSync(join(conv, "events.jsonl")).size).toBeLessThan(3 * 1024 * 1024);
  const events = loadEvents(dataDir, cv);
  expect(events[0]!.kind).toBe("session");
  expect(events.at(-1)).toMatchObject({ kind: "tool", turnId: "tn_01", data: { callId: "call_01" } });
});

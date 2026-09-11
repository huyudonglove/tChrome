import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContextRecord, saveContextRecord } from "./records.ts";
import { saveMemory } from "../memory/store.ts";

const dirs: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), "tchrome-records-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("source records persist independently of windows and cannot be replaced", () => {
  const dir = temporary();
  const record = { id: "input_tn_01", userInput: "保留原文😀", turnId: "tn_01" };
  saveContextRecord(dir, "cv_01", "userInput", record);
  saveContextRecord(dir, "cv_01", "userInput", { ...record });
  expect(() => saveContextRecord(dir, "cv_01", "userInput", { ...record, userInput: "替换" })).toThrow("immutable");
  expect(JSON.parse(loadContextRecord(dir, "cv_01", "userInput", record.id)!)).toEqual(record);
  expect(loadContextRecord(dir, "cv_02", "userInput", record.id)).toBeNull();
  expect(readdirSync(join(dir, "conversations", "cv_01", "context-records", "userInput"))).toEqual([`${record.id}.json`]);
  expect(loadContextRecord(dir, "cv_01", "userInput", "../../input_tn_01")).toBeNull();
  expect(loadContextRecord(dir, "../cv_01", "memory", "m_01")).toBeNull();
});

test("source store retrieves archived input, goal, page and both memory layers", async () => {
  const dir = temporary();
  for (const kind of ["userInput", "goal", "pageObservation"] as const) {
    saveContextRecord(dir, "cv_01", kind, { id: `${kind}_01`, text: `完整${kind}原文` });
  }
  for (const layer of ["conversation", "project"] as const) {
    saveMemory(dir, "cv_01", { memoryId: `${layer}_01`, layer, text: "持久记忆", summary: "", compressed: false,
      createdAt: "2026-09-11T00:00:00.000Z", sourceCallId: "call_01" });
  }
  const query = async (kind: string, id: string, conversationId = "cv_01") => {
    const text = loadContextRecord(dir, conversationId, kind as "userInput" | "goal" | "pageObservation" | "memory", id);
    return { ok: text !== null, text: text ?? "", source: { kind, id, historical: true } };
  };
  for (const kind of ["userInput", "goal", "pageObservation"]) {
    const result = await query(kind, `${kind}_01`);
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.text).text).toBe(`完整${kind}原文`);
    expect(result.source).toEqual({ kind, id: `${kind}_01`, historical: true });
  }
  expect(JSON.parse((await query("memory", "conversation_01")).text).text).toBe("持久记忆");
  expect((await query("memory", "conversation_01", "cv_02")).ok).toBe(false);
  expect(JSON.parse((await query("memory", "project_01", "cv_02")).text).layer).toBe("project");
  expect((await query("memory", "missing")).ok).toBe(false);
  expect((await query("userInput", "../input_tn_01")).ok).toBe(false);
});

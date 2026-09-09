import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newConversation, openConversation, listConversations, loadLedger, saveLedger } from "./store";

test("conversation order is fixed by creation, not selection or activity", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-order-"));
  try {
    for (let i = 0; i < 12; i++) newConversation(dir);
    // Equal timestamps exercise numeric cv_09/cv_10 tie-breaking.
    for (const item of listConversations(dir)) {
      const ledger = loadLedger(dir, item.conversationId);
      ledger.createdAt = "2026-01-01T00:00:00.000Z";
      saveLedger(dir, ledger);
    }
    const ids = () => listConversations(dir).map((item) => item.conversationId);
    const before = ids();
    expect(before.slice(0, 4)).toEqual(["cv_12", "cv_11", "cv_10", "cv_09"]);
    const updatedAt = loadLedger(dir, "cv_01").updatedAt;
    openConversation(dir, "cv_01");
    expect(ids()).toEqual(before);
    expect(loadLedger(dir, "cv_01").updatedAt).toBe(updatedAt);
    saveLedger(dir, loadLedger(dir, "cv_01"));
    expect(ids()).toEqual(before);
    expect(newConversation(dir).conversationId).toBe("cv_13");
    expect(ids()[0]).toBe("cv_13");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

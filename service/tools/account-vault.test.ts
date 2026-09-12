import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAccountVault } from "./account-vault.ts";

test("account ID updates persist the full identity and allow clearing optional fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-vault-"));
  try {
    const original = runAccountVault(dir, { action: "save", site: "old.example.com", username: "old", password: "old-secret", label: "work", note: "obsolete" }).account!;
    expect(original.id).toBe("account_01");
    const updated = runAccountVault(dir, { action: "save", id: original.id, site: "https://NEW.example.com/path", username: " new ", password: "new-secret", note: "" });
    expect(updated).toMatchObject({ ok: true, account: { id: original.id, site: "new.example.com", username: "new", password: "new-secret", label: "work", note: "", createdAt: original.createdAt } });
    expect(runAccountVault(dir, { action: "get", site: "old.example.com", username: "old" }).ok).toBe(false);
    expect(runAccountVault(dir, { action: "get", site: "new.example.com", username: "new" })).toEqual(updated);
    const upserted = runAccountVault(dir, { action: "save", site: "new.example.com", username: "new", password: "rotated", label: "" });
    expect(upserted).toMatchObject({ ok: true, account: { id: original.id, label: "", note: "", password: "rotated" } });
    expect(JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8"))).toEqual([upserted.account]);
    runAccountVault(dir, { action: "delete", id: original.id });
    expect(runAccountVault(dir, { action: "save", site: "next.example.com", username: "next", password: "next" }).account!.id).toBe("account_02");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit account IDs never fall back to a different credential or overwrite an identity collision", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-vault-"));
  try {
    const first = runAccountVault(dir, { action: "save", site: "one.example.com", username: "one", password: "first" }).account!;
    const second = runAccountVault(dir, { action: "save", site: "two.example.com", username: "two", password: "second" }).account!;
    const before = readFileSync(join(dir, "accounts.json"), "utf8");
    for (const id of [first.id, "missing-id", ""]) {
      expect(runAccountVault(dir, { action: "save", id, site: second.site, username: second.username, password: "replacement" }).ok).toBe(false);
      expect(readFileSync(join(dir, "accounts.json"), "utf8")).toBe(before);
    }
    expect(runAccountVault(dir, { action: "get", id: first.id, site: second.site, username: second.username }).account).toEqual(first);
    expect(runAccountVault(dir, { action: "get", id: "missing-id", site: second.site }).ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { runLocalDiagnose } from "./local-diagnose.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("runLocalDiagnose validates cwd and kind", async () => {
  const res1 = await runLocalDiagnose({ cwd: "relative/path", kind: "typecheck" });
  expect(res1.ok).toBe(false);

  const res2 = await runLocalDiagnose({ cwd: "/non/existent/dir", kind: "typecheck" });
  expect(res2.ok).toBe(false);

  const tmp = mkdtempSync(join(tmpdir(), "diag-test-"));
  try {
    const res3 = await runLocalDiagnose({ cwd: tmp, kind: "invalid" as any });
    expect(res3.ok).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLocalDiagnose passes for successful tests", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "diag-test-"));
  try {
    const testFile = join(tmp, "pass.test.ts");
    writeFileSync(testFile, 'import { test, expect } from "bun:test"; test("ok", () => expect(1).toBe(1));');
    const res = await runLocalDiagnose({ cwd: tmp, kind: "test", target: "pass.test.ts" });
    expect(res.ok).toBe(true);
    expect(res.passed).toBe(true);
    expect(res.summary).toContain("passed");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("runLocalDiagnose captures failures with structured information", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "diag-test-"));
  try {
    const testFile = join(tmp, "fail.test.ts");
    writeFileSync(testFile, 'import { test, expect } from "bun:test"; test("should fail", () => expect(1).toBe(2));');
    const res = await runLocalDiagnose({ cwd: tmp, kind: "test", target: "fail.test.ts" });
    expect(res.ok).toBe(true);
    expect(res.passed).toBe(false);
    expect(Array.isArray(res.errors)).toBe(true);
    expect((res.errors as any[]).length).toBeGreaterThan(0);
    expect(res.rawTail).toBeDefined();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

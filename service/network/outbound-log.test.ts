import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { saveOutboundRequest, type OutboundRequestRecord } from "./outbound-log.ts";

const record = (conversationId = "cv_01"): OutboundRequestRecord => ({
  conversationId, turnId: "tn_01", requestId: "req_01", attempt: 1,
  method: "POST", endpoint: "https://example.test/v1/chat/completions",
  body: '{ "messages": [{"role":"user","content":"你好 🌏\\n原文"}], "stream": true }',
});

test("stores the exact request body and attribution in a private file", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-outbound-"));
  try {
    const input = record();
    const before = structuredClone(input);
    const path = saveOutboundRequest(dir, input);
    expect(isAbsolute(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    const { loggedAt, ...fields } = saved;
    expect(fields).toEqual(before);
    expect(new Date(loggedAt).toISOString()).toBe(loggedAt);
    expect(input).toEqual(before);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "provider-requests"))).toEqual(["out_01.json"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("retains the latest 100 attempts globally using persisted numeric IDs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-outbound-"));
  try {
    for (let index = 1; index <= 101; index++) {
      saveOutboundRequest(dir, { ...record(index % 2 ? "cv_01" : "cv_02"), attempt: index });
    }
    const files = readdirSync(join(dir, "provider-requests"));
    expect(files).toHaveLength(100);
    expect(files).not.toContain("out_01.json");
    expect(files).toContain("out_02.json");
    expect(files).toContain("out_100.json");
    expect(files).toContain("out_101.json");
    expect(JSON.parse(readFileSync(join(dir, "id-counters.json"), "utf8")).outboundRequest).toBe(101);

    // A fresh process must continue the persisted sequence and the same retention window.
    const child = Bun.spawn([process.execPath, "-e", `import { saveOutboundRequest } from ${JSON.stringify(import.meta.dir + "/outbound-log.ts")}; console.log(saveOutboundRequest(process.argv[1], JSON.parse(process.argv[2])));`, dir, JSON.stringify(record("cv_03"))], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(basename(output.trim())).toBe("out_102.json");
    const after = readdirSync(join(dir, "provider-requests"));
    expect(after).toHaveLength(100);
    expect(after).not.toContain("out_02.json");
    expect(after).toContain("out_03.json");
    expect(JSON.parse(readFileSync(output.trim(), "utf8")).conversationId).toBe("cv_03");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

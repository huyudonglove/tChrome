import { expect, test } from "bun:test";
import { admitImages, admitText, deferredImageNote, summarizePayload } from "./admission.ts";
import { runtimeConfig } from "./config/runtime.ts";

test("admitText inlines small text and degrades large text with a precise-fetch hint", () => {
  const small = admitText("hello", { callId: "call_01", path: "/tmp/a.txt" });
  expect(small).toEqual({ mode: "inline", text: "hello" });
  const large = admitText("x".repeat(5000), { callId: "call_01", path: "/tmp/a.txt", name: "demo" });
  expect(large.mode).toBe("preview");
  if (large.mode !== "preview") throw new Error("mode");
  expect(large.payload.externalized).toBe(true);
  expect(large.payload.preview).toBe("x".repeat(runtimeConfig.results.previewChars));
  expect(String(large.payload.message)).toContain("更精准");
  expect(String(large.payload.message)).toContain("evidence.search(windows=[{callId=call_01");
});

test("admitText turns an oversized JSON payload into a structured summary instead of a raw head slice", () => {
  const payload = {
    ok: true,
    results: [
      { ok: true, path: "/tmp/a.ts", content: "y".repeat(5000), startLine: 1, endLine: 40, totalLines: 400 },
      { ok: true, path: "/tmp/b.ts", content: "z".repeat(5000), startLine: 10, endLine: 20, totalLines: 90 },
    ],
  };
  const admitted = admitText(JSON.stringify(payload), { callId: "call_02", path: "/tmp/returns/call_02.txt", name: "local.fs_read" });
  expect(admitted.mode).toBe("preview");
  if (admitted.mode !== "preview") throw new Error("mode");
  const summary = String(admitted.payload.summary);
  expect(summary).toContain("results×2");
  expect(summary).toContain("a.ts:1-40/400");
  expect(summary).toContain("b.ts:10-20/90");
  expect(admitted.payload.preview).toBe(summary);
  expect(String(admitted.payload.message)).toContain("结构化摘要");
});

test("summarizePayload reports failures and keeps non-JSON payloads on the raw head slice", () => {
  const failed = JSON.stringify({ toolName: "local.fs_grep", ok: false, faultCode: "tool_execution_failed", message: "path must be a directory" });
  expect(summarizePayload(failed)).toContain("faultCode=tool_execution_failed");
  expect(summarizePayload(failed)).toContain("path must be a directory");
  expect(summarizePayload("not json at all")).toBe("");
  const plain = admitText("q".repeat(5000), { callId: "call_03", path: "/tmp/a.txt" });
  if (plain.mode !== "preview") throw new Error("mode");
  expect(plain.payload.summary).toBeUndefined();
  expect(plain.payload.preview).toBe("q".repeat(runtimeConfig.results.previewChars));
});

test("admitImages splits by byte gate and deferred note asks for a tighter capture", () => {
  const { inline, deferred } = admitImages([
    { bytes: 10, id: "img_01" },
    { bytes: 5_000_000, id: "img_02" },
  ]);
  expect(inline.map((image) => image.id)).toEqual(["img_01"]);
  expect(deferred.map((image) => image.id)).toEqual(["img_02"]);
  const note = deferredImageNote([{ id: "img_02", path: "images/img_02.png", width: 4000, height: 3000, bytes: 5_000_000 }]);
  expect(note).toContain("img_02");
  expect(note).toContain("更精准");
  expect(deferredImageNote([])).toBe("");
});

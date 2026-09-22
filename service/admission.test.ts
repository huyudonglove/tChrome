import { expect, test } from "bun:test";
import { admitImages, admitText, deferredImageNote } from "./admission.ts";

test("admitText inlines small text and degrades large text with a precise-fetch hint", () => {
  const small = admitText("hello", { callId: "call_01", path: "/tmp/a.txt" });
  expect(small).toEqual({ mode: "inline", text: "hello" });
  const large = admitText("x".repeat(5000), { callId: "call_01", path: "/tmp/a.txt", name: "demo" });
  expect(large.mode).toBe("preview");
  if (large.mode !== "preview") throw new Error("mode");
  expect(large.payload.externalized).toBe(true);
  expect(large.payload.preview).toBe("x".repeat(100));
  expect(String(large.payload.message)).toContain("更精准");
  expect(String(large.payload.message)).toContain("evidence.search(callId=call_01");
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

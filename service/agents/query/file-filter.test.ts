import { expect, test } from "bun:test";
import { recordTouchesFile, toolArgFiles, normalizeFileQuery } from "./file-filter.ts";
test("loop evidence matches attributed paths, not arbitrary body prose", () => {
 expect(recordTouchesFile({ runtime: [{ content: { args: { items: [{ path: "src/auth.ts:10-20" }] } } }] }, "loops", "auth.ts")).toBe(true);
 expect(recordTouchesFile({ content: "read auth.ts" }, "runtime", "auth.ts")).toBe(false);
 expect(recordTouchesFile({ result: "auth.ts checked" }, "summaries", "auth.ts")).toBe(true);
 expect(toolArgFiles({ source: "a", destination: "b" })).toEqual(["a", "b"]);
 expect(normalizeFileQuery("  ")).toBeNull();
});

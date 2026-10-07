import { expect, test } from "bun:test";
import { FILE_FILTER_MODULES, normalizeFileQuery, recordTouchesFile } from "./file-filter.ts";

test("normalizeFileQuery trims and treats blank/non-string as no filter", () => {
  expect(normalizeFileQuery("  src/auth.ts ")).toBe("src/auth.ts");
  expect(normalizeFileQuery("   ")).toBeNull();
  expect(normalizeFileQuery("")).toBeNull();
  expect(normalizeFileQuery(undefined)).toBeNull();
  expect(normalizeFileQuery(42)).toBeNull();
});

for (const module of ["workspace", "notes"]) test(`${module} matches its files[] attribution in both directions`, () => {
  const entry = { files: ["src/auth.ts:120-180"] };
  expect(recordTouchesFile(entry, module, "auth.ts")).toBe(true);
  expect(recordTouchesFile(entry, module, "/Users/x/proj/src/auth.ts")).toBe(true);
  expect(recordTouchesFile(entry, module, "src/other.ts")).toBe(false);
  expect(recordTouchesFile({ op: "读了 auth.ts" }, module, "auth.ts")).toBe(false);
  expect(recordTouchesFile({ files: [] }, module, "auth.ts")).toBe(false);
});

test("toolIO matches file arguments, not free-text reasons", () => {
  const read = { arguments: { reason: "读鉴权实现", items: [{ path: "src/auth.ts", startLine: 1 }] } };
  expect(recordTouchesFile(read, "toolIO", "auth.ts")).toBe(true);
  const reasonOnly = { arguments: { reason: "读了 auth.ts 的实现" } };
  expect(recordTouchesFile(reasonOnly, "toolIO", "auth.ts")).toBe(false);
  const writer = { arguments: { reason: "写", path: "src/list.ts", content: "..." } };
  expect(recordTouchesFile(writer, "toolIO", "src/list.ts")).toBe(true);
  expect(recordTouchesFile(writer, "toolIO", "src/auth.ts")).toBe(false);
});

test("summaries matches prose mentions; other modules never match", () => {
  const row = { summary: "读了 auth.ts，token 在此校验", userRequest: "查鉴权", actions: "读", result: "ok" };
  expect(recordTouchesFile(row, "summaries", "auth.ts")).toBe(true);
  expect(recordTouchesFile(row, "summaries", "other.ts")).toBe(false);
  expect(recordTouchesFile({ text: "auth.ts" }, "observations", "auth.ts")).toBe(false);
  expect(recordTouchesFile({ text: "auth.ts" }, "userInput", "auth.ts")).toBe(false);
});

test("file filter covers workspace, notes, toolIO and summaries", () => {
  expect([...FILE_FILTER_MODULES]).toEqual(["workspace", "notes", "toolIO", "summaries"]);
});

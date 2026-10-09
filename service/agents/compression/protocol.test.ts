import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { requestLoopSummaries, requestLoopFold, compressionLoopsFromUserMessage } from "./protocol.ts";
import { loop, model, repoRoot } from "./test-fixtures.ts";
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const setup = () => { const dataDir = mkdtempSync(`${tmpdir()}/loop-protocol-`); dirs.push(dataDir); return { dataDir, conversationId: "cv_test", repoRoot }; };
test("source loop IDs are filled by runtime and complete loop bodies reach compression", async () => {
 const loops = [loop("loop_01", "userInput"), loop("loop_02")];
 const result = await requestLoopSummaries({ ...setup(), loops, provider: model(request => expect(compressionLoopsFromUserMessage(request.messages[1]!.content)).toEqual(loops), 2) });
 expect(result).toHaveLength(2); expect(result.every(row => row.loopIds.join() === "loop_01,loop_02")).toBe(true);
 expect(result[0]!.userRequest).toBe("修复并验证");
});
test("one bad submission rejects all summaries in the response", async () => {
 const good = model(undefined, 2); let calls = 0;
 await expect(requestLoopSummaries({ ...setup(), loops: [loop("loop_01")], provider: { async complete(request) { calls++; const response = await good.complete(request); response.toolCalls[1]!.arguments = { summary: "bad" }; return response; } } })).rejects.toThrow();
 expect(calls).toBe(1);
});
test("fold rejects multiple submissions instead of silently ignoring later entries", async () => {
 await expect(requestLoopFold({ ...setup(), level: 2, loopIds: ["loop_01", "loop_02"], rows: [], provider: model(undefined, 2) })).rejects.toThrow();
});

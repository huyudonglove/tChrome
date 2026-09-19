import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../provider/uuapi.ts";
import { handleTurn } from "../runtime/loop.ts";
import { deleteConversation, loadLedger, paths } from "../runtime/store.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;
// A second real PNG distinguishes image selection from accidental deduplication.
const secondDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC";

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

test("截图按调用批次发送，历史仅保留路径，删除会话清理图片", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-images-integration-"));
  const requests: any[] = [];
  const screenshotCall = { name: "capture_page", arguments: { tabId: 1, mode: "viewport", reason: "观察页面", affectsPage: false } };
  const calls = [
    [{ name: "catalog.add", arguments: { names: ["capture_page"], reason: "加载截图" } }],
    [screenshotCall, screenshotCall],
    [{ name: "notes.write", arguments: { key: "observation", value: "已观察两张截图", reason: "记录", affectsPage: false } }],
    [screenshotCall],
    [{ name: "finishTurn", arguments: { reason: "已观察图片", affectsPage: false, text: "完成", summary: "完成"} }],
  ];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const call = calls[requests.length - 1];
      if (!call) return Response.json({ error: { message: "unexpected extra request" } }, { status: 400 });
      return Response.json({
        id: `response-${requests.length}`, object: "chat.completion", created: 0, model: "test",
        choices: [{ index: 0, finish_reason: "tool_calls", message: {
          role: "assistant", content: "", tool_calls: call.map((item, index) => ({
            id: `call-${requests.length}-${index}`, type: "function",
            function: { name: item.name, arguments: JSON.stringify(item.arguments) },
          })),
        } }],
      });
    },
  });
  try {
    const executed: string[] = [];
    const reply = await handleTurn({
      dataDir, repoRoot: join(import.meta.dir, "../.."),
      provider: createProvider({ apiKey: "test", baseURL: `http://127.0.0.1:${server.port}/v1`, proxy: "" }),
      host: { execute: async (name) => {
        executed.push(name);
        return { ok: true, image: executed.length === 2 ? secondDataUrl : dataUrl, mime: "image/png" };
      } },
    }, { userInput: "截图看看页面", submittedAt: new Date().toISOString() });

    expect(reply.output).toEqual({ kind: "reply", text: "完成", summary: "完成" });
    expect(executed).toEqual(["capture_page", "capture_page", "capture_page"]);
    expect(requests).toHaveLength(5);
    const imagesOf = (request: any) => request.messages
      .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .filter((part: any) => part.type === "image_url")
      .map((part: any) => part.image_url.url);
    expect(imagesOf(requests[2])).toEqual([dataUrl, secondDataUrl]);
    expect(imagesOf(requests[3])).toEqual([]);
    expect(imagesOf(requests[4])).toEqual([dataUrl]);
    const textOf = (request: any) => request.messages.flatMap((message: any) =>
      typeof message.content === "string" ? [message.content]
        : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text)).join("\n");
    for (const request of requests) {
      expect(textOf(request)).not.toContain(png);
      expect(textOf(request)).not.toContain("data:image/");
    }

    const conversationId = "cv_01";
    const ledger = loadLedger(dataDir, conversationId);
    const screenshots = ledger.toolIO.filter((item) => item.name === "capture_page");
    expect(screenshots).toHaveLength(3);
    expect(new Set(screenshots.map(item => item.callId)).size).toBe(3);
    const attachmentLabels = (request: any) => request.messages
      .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .filter((part: any, index: number, parts: any[]) => part.type === "text" && parts[index + 1]?.type === "image_url")
      .map((part: any) => part.text);
    for (const [requestIndex, selected] of [[2, screenshots.slice(0, 2)], [4, screenshots.slice(2)]] as const) {
      const labels = attachmentLabels(requests[requestIndex]);
      expect(labels).toHaveLength(selected.length);
      selected.forEach((item, index) => {
        expect(labels[index]).toContain(item.callId);
        expect(labels[index]).toContain(item.images![0]!.id);
        expect(labels[index]).toContain(item.images![0]!.path);
      });
    }
    for (const screenshot of screenshots) {
      expect(screenshot.images).toHaveLength(1);
      expect(textOf(requests[3])).toContain(screenshot.images![0]!.path);
      expect(textOf(requests[4])).toContain(screenshot.images![0]!.path);
    }
    const storedFiles = filesIn(paths(dataDir, conversationId).conv);
    const imageFiles = storedFiles.filter((path) => path.endsWith(".png"));
    expect(imageFiles).toHaveLength(2);
    expect(readFileSync(join(paths(dataDir, conversationId).conv, screenshots[0]!.images![0]!.path))).toEqual(Buffer.from(png, "base64"));
    expect(storedFiles.some((path) => path.endsWith("provider.md"))).toBe(true);
    expect(storedFiles.some((path) => path.endsWith("events.jsonl"))).toBe(true);
    expect(storedFiles.some((path) => path.includes("/returns/"))).toBe(true);
    for (const path of storedFiles.filter((path) => !imageFiles.includes(path))) {
      const content = readFileSync(path, "utf8");
      expect(content).not.toContain(png);
      expect(content).not.toContain("data:image/");
    }
    deleteConversation(dataDir, conversationId);
    expect(existsSync(imageFiles[0]!)).toBe(false);
  } finally {
    server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  }
});

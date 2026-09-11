import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProvider } from "../provider/uuapi.ts";
import { handleTurn } from "../runtime/loop.ts";
import { deleteConversation, loadLedger, paths } from "../runtime/store.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;

function filesIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

test("截图以图片内容发给模型，持久记录仅保留引用，删除会话清理图片", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tchrome-images-integration-"));
  const requests: any[] = [];
  const calls = [
    { name: "catalog.add", arguments: { names: ["screenshot"], reason: "加载截图" } },
    { name: "screenshot", arguments: { reason: "观察页面", affectsPage: false } },
    { name: "finishTurn", arguments: { reason: "已观察图片", affectsPage: false, text: "完成" } },
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
          role: "assistant", content: "", tool_calls: [{
            id: `call-${requests.length}`, type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
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
        return { ok: true, image: dataUrl, mime: "image/png", image_size: [1, 1], viewport: [1, 1] };
      } },
    }, { userInput: "截图看看页面", submittedAt: new Date().toISOString() });

    expect(reply.output).toEqual({ kind: "reply", text: "完成" });
    expect(executed).toEqual(["screenshot"]);
    expect(requests).toHaveLength(3);
    const parts = requests[2].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
    const images = parts.filter((part: any) => part.type === "image_url");
    expect(images).toHaveLength(1);
    expect(images[0].image_url.url).toBe(dataUrl);
    for (const message of requests[2].messages) {
      const texts = typeof message.content === "string" ? [message.content] : message.content.filter((part: any) => part.type === "text").map((part: any) => part.text);
      expect(texts.join("\n")).not.toContain(png);
      expect(texts.join("\n")).not.toContain("data:image/");
    }

    const conversationId = "cv_01";
    const ledger = loadLedger(dataDir, conversationId);
    const screenshot = ledger.toolIO.find((item) => item.name === "screenshot")!;
    expect(screenshot.images).toHaveLength(1);
    const storedFiles = filesIn(paths(dataDir, conversationId).conv);
    const imageFiles = storedFiles.filter((path) => path.endsWith(".png"));
    expect(imageFiles).toHaveLength(1);
    expect(readFileSync(imageFiles[0]!)).toEqual(Buffer.from(png, "base64"));
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

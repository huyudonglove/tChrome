import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteItem, LibraryError, listItems, saveItem } from "./store.ts";
import { deleteConversation, newConversation } from "../runtime/store.ts";
import { createServer } from "../server.ts";

test("资料跨会话持久化，局部更新保留密码，删除不复用编号", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-library-"));
  try {
    expect(listItems(dir)).toEqual([]);
    const account = saveItem(dir, { type: "account", title: "工作账号", url: "https://example.com", username: "me", password: " secret ", tags: ["工作", "工作", " 常用 "] });
    const website = saveItem(dir, { type: "website", title: "文档", url: "https://docs.example.com" });
    expect(account.id).toBe("lib_01");
    expect(account.tags).toEqual(["工作", "常用"]);
    const updated = saveItem(dir, { id: account.id, content: "备注" });
    expect(updated).toMatchObject({ password: " secret ", createdAt: account.createdAt, content: "备注" });
    expect(listItems(dir, "工作 me")).toEqual([updated]);
    const session = newConversation(dir);
    newConversation(dir);
    deleteConversation(dir, session.conversationId!);
    expect(listItems(dir)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(dir, "library", "items.json"), "utf8")).items).toContainEqual(updated);
    deleteItem(dir, website.id);
    const note = saveItem(dir, { type: "note", title: "提示", content: "一些资料" });
    expect(note.id).toBe("lib_03");
    expect(listItems(dir).map(item => item.id)).not.toContain(website.id);
    expect(() => deleteItem(dir, website.id)).toThrow(LibraryError);
    expect(saveItem(dir, { id: account.id, password: "" }).password).toBe("");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("无效资料不改变已保存条目和编号", () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-library-"));
  try {
    for (const value of [null, [], {}, { type: "unknown", title: "a" }, { type: "note", title: " " }, { type: "note", title: 1 }, { type: "website", title: "a" }, { type: "note", title: "a", tags: [1] }, { type: "note", title: "a", url: "javascript:alert(1)" }, { type: "note", title: "a", password: false }, { id: "../bad", title: "a" }, { id: "lib_99", title: "a" }]) {
      expect(() => saveItem(dir, value)).toThrow(LibraryError);
    }
    expect(listItems(dir)).toEqual([]);
    expect(saveItem(dir, { type: "note", title: "有效" }).id).toBe("lib_01");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("资料 HTTP API 支持增改查删，返回输入错误和未找到状态", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-library-api-"));
  try {
    const server = createServer({ dataDir: dir });
    const post = (path: string, body: unknown) => server.fetch(new Request(`http://127.0.0.1:18788${path}`, { method: "POST", body: JSON.stringify(body) }));
    const response = await post("/library/save", { type: "account", title: "个人", password: "visible" });
    expect(response.status).toBe(200);
    const { item } = await response.json();
    expect(item.password).toBe("visible");
    expect((await (await post("/library/save", { id: item.id, username: "user" })).json()).item.password).toBe("visible");
    const listed = await server.fetch(new Request("http://127.0.0.1:18788/library?q=user"));
    expect((await listed.json()).items).toHaveLength(1);
    expect((await post("/library/save", {})).status).toBe(400);
    expect((await post("/library/save", { id: "lib_99", title: "absent" })).status).toBe(404);
    expect((await post("/library/delete", null)).status).toBe(400);
    expect((await server.fetch(new Request("http://127.0.0.1:18788/library/save", { method: "POST", body: "{" }))).status).toBe(400);
    expect(await (await post("/library/delete", { id: item.id })).json()).toEqual({ ok: true });
    expect((await post("/library/delete", { id: item.id })).status).toBe(404);
    expect(listItems(dir)).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTsxOutline } from "./tsx-outline.ts";

const sample = `
import { useState } from "react";

export function App() {
  const [open, setOpen] = useState(false);
  return (
    <div className="app shell">
      <header className="topbar">
        <h1 className="title">Hi</h1>
      </header>
      {open ? (
        <Modal className="overlay dark" onClose={() => setOpen(false)}>
          <p className={open ? "body visible" : "body"}>text</p>
        </Modal>
      ) : (
        <span className={\`badge \${open ? "on" : "off"}\`} />
      )}
      <Footer />
    </div>
  );
}
`;

test("tsx_outline extracts skeleton and class tally from tsx", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-tsx-"));
  try {
    const file = join(dir, "App.tsx");
    writeFileSync(file, sample);
    const out = await runTsxOutline({ path: file, reason: "看结构" });
    expect(out.ok).toBe(true);
    expect(out.skeleton).toBe([
      "div.app.shell",
      "  header.topbar",
      "    h1.title",
      "  Modal.overlay.dark",
      "    p.body.visible…",
      "  span.badge…",
      "  Footer",
    ].join("\n"));
    expect(out.classes).toEqual([
      { cls: "app", count: 1 },
      { cls: "badge", count: 1 },
      { cls: "body", count: 1 },
      { cls: "dark", count: 1 },
      { cls: "overlay", count: 1 },
      { cls: "shell", count: 1 },
      { cls: "title", count: 1 },
      { cls: "topbar", count: 1 },
      { cls: "visible", count: 1 },
    ]);
    expect(out.stats).toEqual({ elements: 7, components: 2, lines: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tsx_outline honors maxDepth and rejects non-tsx paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tchrome-tsx-"));
  try {
    const file = join(dir, "App.tsx");
    writeFileSync(file, sample);
    const shallow = await runTsxOutline({ path: file, maxDepth: 1, reason: "限深" });
    expect(shallow.ok).toBe(true);
    expect(shallow.skeleton).toBe("div.app.shell");
    expect(shallow.stats).toMatchObject({ elements: 1, lines: 1 });

    const txt = join(dir, "a.txt");
    writeFileSync(txt, "x");
    expect(await runTsxOutline({ path: txt, reason: "错扩展" })).toMatchObject({ ok: false });
    expect(await runTsxOutline({ path: "relative.tsx", reason: "相对路径" })).toMatchObject({ ok: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

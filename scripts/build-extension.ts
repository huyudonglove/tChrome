#!/usr/bin/env bun
import { cpSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
mkdirSync(join(dist, "ui"), { recursive: true });
cpSync(join(root, "manifest.json"), join(dist, "manifest.json"));
cpSync(join(root, "extension", "icons"), join(dist, "icons"), { recursive: true });
cpSync(join(root, "extension", "ui", "tokens.css"), join(dist, "ui", "tokens.css"));
cpSync(join(root, "extension", "sidepanel.html"), join(dist, "sidepanel.html"));
cpSync(join(root, "extension", "content-console.js"), join(dist, "content-console.js"));

const background = await Bun.build({
  entrypoints: [join(root, "extension", "background.ts")],
  outdir: dist,
  target: "browser",
});
if (!background.success) {
  console.error(background.logs.join("\n"));
  process.exit(1);
}

const panel = await Bun.build({
  entrypoints: [join(root, "extension", "sidepanel", "main.tsx")],
  outdir: dist,
  target: "browser",
});
if (!panel.success) {
  console.error(panel.logs.join("\n"));
  process.exit(1);
}

const builtPanel = join(dist, "main.js");
if (existsSync(builtPanel)) renameSync(builtPanel, join(dist, "sidepanel.js"));
console.log("dist ready");

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The service reads the same sources that the extension build fingerprints.
// Keep this deterministic: file names and bytes only, no paths, timestamps or env.
export function executorVersion(repoRoot: string): string {
  const hash = createHash("sha256");
  const files = ["extension/manifest.json", "extension/background.ts", "extension/content-console.js", "service/executor-version.ts"];
  for (const directory of ["extension/tools", "service/tools/definitions"]) {
    for (const name of readdirSync(join(repoRoot, directory)).sort()) {
      if (directory === "extension/tools" ? name.endsWith(".js") : name.endsWith(".json")) files.push(`${directory}/${name}`);
    }
  }
  for (const file of files.sort()) hash.update(file).update("\0").update(readFileSync(join(repoRoot, file))).update("\0");
  return hash.digest("hex");
}

export const executorMismatchMessage = "浏览器扩展与服务工具版本不一致。请执行 bun run build，重启本地服务，并在 chrome://extensions 重新加载本项目 dist 目录的扩展，再重试。";

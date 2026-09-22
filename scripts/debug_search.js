import { execSync } from "child_process";
import fs from "fs";

function run(cmd) {
  try {
    return execSync(cmd, { cwd: "/Users/huyudong/Projects/tChrome", encoding: "utf8" });
  } catch (e) {
    return e.stdout + "\n" + e.stderr;
  }
}

console.log("=== Git Grep finishTurn ===");
console.log(run("git grep -n 'finishTurn'"));

console.log("=== Git Grep toolHistoryView ===");
console.log(run("git grep -n 'toolHistoryView'"));

console.log("=== Git Grep userText ===");
console.log(run("git grep -n 'userText'"));

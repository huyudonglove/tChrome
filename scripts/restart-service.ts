/**
 * 优雅重启 Helm 服务（不依赖守护进程）：先 POST /stop 让服务把运行中的轮次收尾，
 * 再等端口释放并拉起新的 `bun run service/server.ts`，最后可选地用 POST /turn 续跑一段输入。
 *
 * 用法：
 *   bun run scripts/restart-service.ts
 *   bun run scripts/restart-service.ts --continue <conversationId> <输入>
 *   bun run scripts/restart-service.ts --delay 20 --continue <conversationId> <输入>
 *   TCHROME_PORT=18788 bun run scripts/restart-service.ts
 *
 * 环境变量优先（从别的进程 spawn 调用时更可靠，不经过 bun 的选项解析）：
 *   TCHROME_RESTART_DELAY / TCHROME_RESTART_CONTINUE / TCHROME_RESTART_INPUT
 *
 * 注意：脚本会先等目标会话的轮次收尾再 /stop（默认最多等 5 分钟，见 --wait / TCHROME_RESTART_WAIT），
 * 所以轮次正常收尾时不会再被打成 interrupted；只有超时或该轮已死，才会真的打断运行中的轮次。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.TCHROME_PORT ?? 18788);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const listeners = (): number[] => {
  const result = spawnSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return String(result.stdout ?? "")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

const signalAll = (signal: "SIGTERM" | "SIGKILL"): void => {
  for (const pid of listeners()) {
    try { process.kill(pid, signal); } catch { /* 进程已退出 */ }
  }
};

const waitHealthy = async (timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return true;
    } catch { /* 还没开始监听 */ }
    await sleep(200);
  }
  return false;
};

const readSessionConversationId = (dataDir: string): string | undefined => {
  try {
    const session = JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8")) as { conversationId?: string };
    return session.conversationId || undefined;
  } catch { return undefined; }
};

/** 该会话的账本是否还停在 running。读不到（还没建账本 / 文件不可读）就当没在跑。 */
const turnRunning = (dataDir: string, cvId: string): boolean => {
  try {
    const ledger = JSON.parse(readFileSync(join(dataDir, "conversations", cvId, "ledger.json"), "utf8")) as { status?: string };
    return ledger.status === "running";
  } catch { return false; }
};

/** 等该会话的轮次自己收尾。超时返回 false，调用方据此决定是否照常停止。 */
const waitTurnIdle = async (dataDir: string, cvId: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!turnRunning(dataDir, cvId)) return true;
    await sleep(500);
  }
  return !turnRunning(dataDir, cvId);
};

/** 重启脚本的控制变量（TCHROME_RESTART_*）只对本次重启有意义，绝不能透传给新服务：
 *  一旦服务 env 里残留 TCHROME_RESTART_DETACHED=1，下一次从服务内部派发的重启就会
 *  误判「自己已经脱离」，跳过自我脱离、随服务收尾被一起杀掉，结果是只停不换。 */
const withoutRestartEnv = (env: Record<string, string | undefined>): Record<string, string | undefined> => {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("TCHROME_RESTART_")) clean[key] = value;
  }
  return clean;
};

const main = async (): Promise<void> => {
  // 自我脱离：本脚本若由服务进程内的工具调用启动，就属于该服务的进程组；服务收到 SIGTERM 时
  // 会终止整个进程组，把重启脚本一起杀掉，结果「旧的停了、新的没起」。先用 detached 再派生一份
  // 自己（POSIX 上 detached 会让子进程进入新会话组），本进程随即退出，真正的重启动作落在不受
  // 该服务终止影响的副本里执行。
  if (process.env.TCHROME_RESTART_DETACHED !== "1") {
    const detached = spawn(process.execPath, ["run", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      cwd: repoRoot,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TCHROME_RESTART_DETACHED: "1" },
    });
    detached.unref();
    console.log(`已派生独立重启进程 pid=${detached.pid}；本进程退出，避免被即将终止的服务进程组带走`);
    return;
  }
  const dataDir = process.env.TCHROME_DATA ?? join(process.env.HOME ?? ".", "Library", "Application Support", "tChrome");
  const args = process.argv.slice(2);
  const continueAt = args.indexOf("--continue");
  const delayAt = args.indexOf("--delay");
  const waitAt = args.indexOf("--wait");
  // 环境变量优先：从服务进程内部 spawn 本脚本时 env 逐字传递、不经过 bun 的选项解析，
  // 能确保「先延迟、再重启、后自动续跑」这三步不被误读。
  const delaySec = Number(process.env.TCHROME_RESTART_DELAY ?? (delayAt >= 0 ? args[delayAt + 1] : 0));
  // 停服前等本轮结束的时限（默认 5 分钟）。它只决定「什么时候停」，不改变「停完一定重启」。
  const waitSec = Number(process.env.TCHROME_RESTART_WAIT ?? (waitAt >= 0 ? args[waitAt + 1] : 300));
  const waitMs = (Number.isFinite(waitSec) && waitSec > 0 ? waitSec : 0) * 1000;
  const conversationId = process.env.TCHROME_RESTART_CONTINUE ?? (continueAt >= 0 ? args[continueAt + 1] : undefined);
  const continueInput = process.env.TCHROME_RESTART_INPUT ?? (continueAt >= 0 ? args[continueAt + 2] : undefined);

  // 留一段时间给调用方收尾（Agent 通常用这段时间把本轮回复交付完）。
  if (Number.isFinite(delaySec) && delaySec > 0) {
    console.log(`延迟 ${delaySec} 秒后重启`);
    await sleep(delaySec * 1000);
  }

  // 1. 先等本轮做完再让服务停止。
  //    直接 /stop 会把仍在跑的轮次标成 interrupted、当轮工作作废，所以这里先轮询账本等它收尾；
  //    只有超出 waitMs（默认 5 分钟）或该轮已死的情况，才会真的打断运行中的轮次。
  if (listeners().length) {
    const targetCv = conversationId ?? readSessionConversationId(dataDir);
    if (targetCv && waitMs > 0) {
      const idle = await waitTurnIdle(dataDir, targetCv, waitMs);
      if (!idle) console.error(`会话 ${targetCv} 在 ${Math.round(waitMs / 1000)} 秒内仍未结束，改为按计划停止`);
      else console.log(`会话 ${targetCv} 已不在运行，继续重启`);
    }
    try {
      await fetch(`${base}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // initiatedBy=service 让这一轮的 stopReason 能区分出是脚本安排的停止，不是人按的。
        body: JSON.stringify({ ...(targetCv ? { conversationId: targetCv } : {}), initiatedBy: "service" }),
      });
      await sleep(500);
    } catch { /* 服务已经不在监听 */ }
  }

  // 2. 终止旧进程：先给 SIGTERM 机会，超过 10 秒再 SIGKILL。
  signalAll("SIGTERM");
  const killDeadline = Date.now() + 10_000;
  while (listeners().length && Date.now() < killDeadline) await sleep(250);
  if (listeners().length) {
    signalAll("SIGKILL");
    await sleep(500);
  }
  const leftover = listeners();
  if (leftover.length) {
    console.error(`端口 ${port} 仍被占用：${leftover.join(", ")}`);
    process.exit(1);
  }

  // 3. 拉起新进程，日志追加到服务数据目录的 process-output/service-restart.log。
  const logDir = join(dataDir, "process-output");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "service-restart.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, ["run", "service/server.ts"], {
    cwd: repoRoot,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // 剔除 TCHROME_RESTART_*：它们只对本次重启有意义，透传进服务会污染服务 env，
    // 让下一次从服务内部派发的重启误判「已脱离」（tn_20 只停不换的根因）。
    env: withoutRestartEnv(process.env),
  });
  child.unref();

  // 4. 等健康检查通过，确认新进程真的在服务。
  if (!(await waitHealthy(20_000))) {
    console.error(`服务未在 20 秒内恢复，请查看日志：${logPath}`);
    process.exit(1);
  }

  // 5. 可选续跑：把「重启后接着做」的一次输入提交给会话。
  if (conversationId && continueInput) {
    const response = await fetch(`${base}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversationId, userInput: continueInput }),
    });
    console.log(`续跑已提交（HTTP ${response.status}）：${conversationId}`);
  }
  console.log(`服务已重启：pid=${child.pid} port=${port} log=${logPath}`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

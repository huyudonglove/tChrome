import { expect, test } from "bun:test";
import {
  assertAllowedPermissions,
  assertValidSubagentResult,
  buildTaskPrompt,
  createTaskPacket,
  runSubagentDag,
  type SubagentResult,
} from "./index.ts";
import { MAX_SUBAGENT_PARALLEL } from "./scheduler.ts";

const packet = (id: string, dependencies: string[] = []) => createTaskPacket({
  id,
  role: "researcher",
  objective: `完成 ${id}`,
  facts: ["事实"],
  constraints: ["不得扩大范围"],
  acceptanceCriteria: ["返回结构化证据"],
  dependencies,
});

const success = (taskId: string, summary = `${taskId} 完成`): SubagentResult => ({
  taskId,
  status: "success",
  summary,
  evidence: [{ kind: "test", summary: "确定性测试证据" }],
});

test("Task Packet applies role permission ceilings and builds bounded prompt envelope", () => {
  const task = packet("research");
  expect(task.permissions).toEqual(["read", "test"]);
  expect(buildTaskPrompt(task)).toContain("<subagentTask>");
  expect(buildTaskPrompt(task)).toContain('"objective":"完成 research"');
  expect(() => assertAllowedPermissions("researcher", ["write"]))
    .toThrow("不允许使用权限");
});

test("DAG runs independent tasks in parallel and passes dependency results", async () => {
  const packets = [packet("a"), packet("b"), packet("c", ["a", "b"])] as const;
  const starts: string[] = [];
  const dependencyCounts: number[] = [];
  const result = await runSubagentDag(packets, async ({ packet: task, dependencyResults }) => {
    starts.push(task.id);
    dependencyCounts.push(dependencyResults.length);
    await Promise.resolve();
    return success(task.id);
  }, { maxParallel: 2 });

  expect(result.results.a?.status).toBe("success");
  expect(result.results.b?.status).toBe("success");
  expect(result.results.c?.status).toBe("success");
  expect(result.executionOrder).toEqual(["a", "b", "c"]);
  expect(starts).toEqual(["a", "b", "c"]);
  expect(dependencyCounts).toEqual([0, 0, 2]);
});

test("failed dependencies block descendants without executing them", async () => {
  const packets = [packet("root"), packet("child", ["root"]), packet("grandchild", ["child"])] as const;
  const executed: string[] = [];
  const result = await runSubagentDag(packets, async ({ packet: task }) => {
    executed.push(task.id);
    if (task.id === "root") throw new Error("root failed");
    return success(task.id);
  });

  expect(executed).toEqual(["root"]);
  expect(result.results.root?.status).toBe("failed");
  expect(result.results.child?.status).toBe("blocked");
  expect(result.results.grandchild?.status).toBe("blocked");
});

test("scheduler rejects missing and cyclic dependencies", async () => {
  await expect(runSubagentDag([packet("a", ["missing"])], async ({ packet: task }) => success(task.id)))
    .rejects.toThrow("依赖不存在");
  await expect(runSubagentDag([packet("a", ["b"]), packet("b", ["a"])], async ({ packet: task }) => success(task.id)))
    .rejects.toThrow("存在环");
});

test("structured result validation rejects wrong task ids and empty evidence fields", () => {
  expect(() => assertValidSubagentResult({
    taskId: "wrong",
    status: "success",
    summary: "有结果",
    evidence: [{ kind: "test", summary: "证据" }],
  }, "expected")).toThrow("taskId");
  expect(() => assertValidSubagentResult({
    taskId: "expected",
    status: "success",
    summary: "有结果",
    evidence: [{ kind: "test", summary: "" }],
  }, "expected")).toThrow("evidence[0].summary");
});

// D 项：maxParallel 上界。超过上界的值不再照单全收，波次按上界收窄。
test("maxParallel 超过上界时被钳制，波次不会一次性铺开全部任务", async () => {
  const packets = Array.from({ length: MAX_SUBAGENT_PARALLEL + 6 }, (_, index) => packet(`t${index}`));
  let running = 0;
  let peak = 0;
  const result = await runSubagentDag(packets, async ({ packet: task }) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return success(task.id);
  }, { maxParallel: 1000 });
  expect(result.executionOrder).toHaveLength(packets.length);
  expect(peak).toBe(MAX_SUBAGENT_PARALLEL);
});

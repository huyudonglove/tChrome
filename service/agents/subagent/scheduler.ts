import type {
  DagRunResult,
  SubagentExecutor,
  SubagentResult,
  TaskPacket,
} from "./types.ts";
import { assertValidTaskPacket } from "./validator.ts";

export type SchedulerOptions = { maxParallel?: number };

const failure = (taskId: string, summary: string, error?: string): SubagentResult => ({
  taskId,
  status: "failed",
  summary,
  evidence: [],
  ...(error ? { errors: [error] } : {}),
});

const blocked = (taskId: string, dependencyIds: readonly string[]): SubagentResult => ({
  taskId,
  status: "blocked",
  summary: `依赖任务未成功：${dependencyIds.join(", ")}`,
  evidence: [],
  errors: [`blocked_by:${dependencyIds.join(",")}`],
});

function assertDag(packets: readonly TaskPacket[]): Map<string, TaskPacket> {
  const byId = new Map<string, TaskPacket>();
  for (const packet of packets) {
    assertValidTaskPacket(packet);
    if (byId.has(packet.id)) throw new Error(`Task Packet id 重复：${packet.id}`);
    byId.set(packet.id, packet);
  }
  for (const packet of packets) {
    for (const dependency of packet.dependencies) {
      if (!byId.has(dependency)) throw new Error(`Task Packet ${packet.id} 依赖不存在：${dependency}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Task Packet 依赖存在环：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)!.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const packet of packets) visit(packet.id);
  return byId;
}

/** Run a validated dependency DAG in bounded waves; failed nodes block descendants. */
export async function runSubagentDag(
  packets: readonly TaskPacket[],
  executor: SubagentExecutor,
  options: SchedulerOptions = {},
): Promise<DagRunResult> {
  if (!packets.length) return { results: {}, executionOrder: [] };
  const maxParallel = options.maxParallel ?? 4;
  if (!Number.isSafeInteger(maxParallel) || maxParallel < 1) {
    throw new Error("maxParallel 必须是大于 0 的整数");
  }
  const byId = assertDag(packets);
  const pending = new Set(packets.map((packet) => packet.id));
  const results: Record<string, SubagentResult> = {};
  const executionOrder: string[] = [];

  while (pending.size) {
    let changed = false;
    // Propagate failures before selecting the next runnable wave.
    for (const id of [...pending]) {
      const packet = byId.get(id)!;
      const failedDependencies = packet.dependencies.filter((dependency) => {
        const result = results[dependency];
        return result !== undefined && result.status !== "success";
      });
      if (failedDependencies.length) {
        results[id] = blocked(id, failedDependencies);
        pending.delete(id);
        executionOrder.push(id);
        changed = true;
      }
    }

    const ready = [...pending].filter((id) =>
      byId.get(id)!.dependencies.every((dependency) => results[dependency]?.status === "success"),
    );
    if (!ready.length) {
      if (changed) continue;
      throw new Error("DAG 无法继续：存在未解决的依赖");
    }

    const wave = ready.slice(0, maxParallel);
    const waveResults = await Promise.all(wave.map(async (id) => {
      const packet = byId.get(id)!;
      const dependencyResults = packet.dependencies.map((dependency) => results[dependency]!);
      try {
        const result = await executor({ packet, dependencyResults });
        if (result.taskId !== packet.id) {
          return [id, failure(id, "执行器返回了错误的 taskId", `expected:${id},actual:${result.taskId}`)] as const;
        }
        try {
          // Importing the assertion here would make malformed executor output a regular failed node.
          const { assertValidSubagentResult } = await import("./validator.ts");
          assertValidSubagentResult(result, packet.id);
          return [id, result] as const;
        } catch (error) {
          return [id, failure(id, "执行器结果未通过结构化校验", error instanceof Error ? error.message : String(error))] as const;
        }
      } catch (error) {
        return [id, failure(id, "子任务执行失败", error instanceof Error ? error.message : String(error))] as const;
      }
    }));
    for (const [id, result] of waveResults) {
      results[id] = result;
      pending.delete(id);
      executionOrder.push(id);
    }
  }

  return { results, executionOrder };
}

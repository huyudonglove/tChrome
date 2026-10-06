import {
  ROLE_PERMISSIONS,
  type SubagentEvidence,
  type SubagentResult,
  type SubagentRole,
  type TaskPacket,
} from "./types.ts";
import { assertAllowedPermissions } from "./permissions.ts";

export type ValidationIssue = { field: string; message: string };

const roles = new Set<SubagentRole>(Object.keys(ROLE_PERMISSIONS) as SubagentRole[]);
const evidenceKinds = new Set<SubagentEvidence["kind"]>([
  "observation", "test", "diff", "artifact",
]);
const resultStatuses = new Set<SubagentResult["status"]>(["success", "failed", "blocked"]);

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function validateTaskPacket(packet: TaskPacket): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!nonEmpty(packet.id)) issues.push({ field: "id", message: "必须是非空字符串" });
  if (!roles.has(packet.role)) issues.push({ field: "role", message: "不是受支持的角色" });
  if (!nonEmpty(packet.objective)) issues.push({ field: "objective", message: "必须是非空字符串" });
  for (const field of ["facts", "constraints", "acceptanceCriteria", "dependencies"] as const) {
    if (!stringArray(packet[field])) issues.push({ field, message: "必须是字符串数组" });
  }
  if (!Array.isArray(packet.permissions)) {
    issues.push({ field: "permissions", message: "必须是权限数组" });
  } else if (roles.has(packet.role)) {
    try {
      assertAllowedPermissions(packet.role, packet.permissions);
    } catch (error) {
      issues.push({ field: "permissions", message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (Array.isArray(packet.dependencies) && packet.dependencies.includes(packet.id)) {
    issues.push({ field: "dependencies", message: "不能依赖自身" });
  }
  return issues;
}

export function validateSubagentResult(
  result: SubagentResult,
  expectedTaskId: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (result.taskId !== expectedTaskId) {
    issues.push({ field: "taskId", message: `必须等于 ${expectedTaskId}` });
  }
  if (!resultStatuses.has(result.status)) {
    issues.push({ field: "status", message: "不是受支持的结果状态" });
  }
  if (!nonEmpty(result.summary)) issues.push({ field: "summary", message: "必须是非空字符串" });
  if (!Array.isArray(result.evidence)) {
    issues.push({ field: "evidence", message: "必须是证据数组" });
  } else {
    result.evidence.forEach((evidence, index) => {
      if (!evidence || typeof evidence !== "object") {
        issues.push({ field: `evidence[${index}]`, message: "必须是对象" });
        return;
      }
      if (!evidenceKinds.has(evidence.kind)) {
        issues.push({ field: `evidence[${index}].kind`, message: "不是受支持的证据类型" });
      }
      if (!nonEmpty(evidence.summary)) {
        issues.push({ field: `evidence[${index}].summary`, message: "必须是非空字符串" });
      }
    });
  }
  return issues;
}

export function assertValidTaskPacket(packet: TaskPacket): void {
  const issues = validateTaskPacket(packet);
  if (issues.length) throw new Error(`Task Packet 无效：${issues.map((issue) => `${issue.field} ${issue.message}`).join("；")}`);
}

export function assertValidSubagentResult(result: SubagentResult, expectedTaskId: string): void {
  const issues = validateSubagentResult(result, expectedTaskId);
  if (issues.length) throw new Error(`Subagent 结果无效：${issues.map((issue) => `${issue.field} ${issue.message}`).join("；")}`);
}

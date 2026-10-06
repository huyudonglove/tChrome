import {
  ROLE_PERMISSIONS,
  type SubagentCapability,
  type SubagentRole,
  type TaskPacket,
} from "./types.ts";

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

export function allowedPermissions(role: SubagentRole): readonly SubagentCapability[] {
  return ROLE_PERMISSIONS[role];
}

export function assertAllowedPermissions(
  role: SubagentRole,
  permissions: readonly SubagentCapability[],
): void {
  const allowed = new Set(allowedPermissions(role));
  const denied = unique(permissions).filter((permission) => !allowed.has(permission));
  if (denied.length) {
    throw new Error(`角色 ${role} 不允许使用权限：${denied.join(", ")}`);
  }
}

type TaskPacketInput = Omit<TaskPacket, "permissions"> & {
  permissions?: readonly SubagentCapability[];
};

/** Create a packet with the role's permission ceiling applied explicitly. */
export function createTaskPacket(input: TaskPacketInput): TaskPacket {
  const permissions = unique(input.permissions ?? allowedPermissions(input.role));
  assertAllowedPermissions(input.role, permissions);
  if (!input.id.trim()) throw new Error("Task Packet id 不能为空");
  if (!input.objective.trim()) throw new Error("Task Packet objective 不能为空");
  if (input.dependencies.includes(input.id)) throw new Error("Task Packet 不能依赖自身");

  return {
    ...input,
    facts: [...input.facts],
    constraints: [...input.constraints],
    acceptanceCriteria: [...input.acceptanceCriteria],
    dependencies: unique(input.dependencies),
    permissions,
  };
}

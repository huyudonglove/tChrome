export type SubagentRole = "researcher" | "reproducer" | "implementer" | "reviewer";

export type SubagentCapability = "read" | "write" | "test" | "browser";

export const ROLE_PERMISSIONS: Readonly<Record<SubagentRole, readonly SubagentCapability[]>> = {
  researcher: ["read", "test"],
  reproducer: ["read", "test", "browser"],
  implementer: ["read", "write", "test"],
  reviewer: ["read", "test"],
};

export type TaskPacket = {
  id: string;
  role: SubagentRole;
  objective: string;
  facts: readonly string[];
  constraints: readonly string[];
  acceptanceCriteria: readonly string[];
  dependencies: readonly string[];
  permissions: readonly SubagentCapability[];
};

export type SubagentEvidenceKind = "observation" | "test" | "diff" | "artifact";

export type SubagentEvidence = {
  kind: SubagentEvidenceKind;
  summary: string;
  source?: string;
};

export type SubagentResultStatus = "success" | "failed" | "blocked";

export type SubagentResult = {
  taskId: string;
  status: SubagentResultStatus;
  summary: string;
  evidence: readonly SubagentEvidence[];
  errors?: readonly string[];
};

export type SubagentContext = {
  packet: TaskPacket;
  dependencyResults: readonly SubagentResult[];
};

export type SubagentExecutor = (context: SubagentContext) => Promise<SubagentResult>;

export type DagRunResult = {
  results: Readonly<Record<string, SubagentResult>>;
  executionOrder: readonly string[];
};

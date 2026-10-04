export const CAPABILITY_RISKS = ["low", "medium", "high", "unknown"];

export type CapabilityKind = "tool" | "skill";
export type CapabilityRisk = (typeof CAPABILITY_RISKS)[number];
export type CapabilityAvailability =
  | "base"
  | "core"
  | "browser"
  | "service"
  | "resident"
  | "dynamic";

export type CapabilityInput = {
  name: string;
  required: boolean;
};

export type CapabilityRecord = {
  id: string;
  kind: CapabilityKind;
  name: string;
  purpose: string;
  triggers: string[];
  inputs: CapabilityInput[];
  outputs: string[];
  preconditions: string[];
  risk: CapabilityRisk;
  /** 是否纯只读（只观察不改变状态）。兜底计数用：只读累积，其余清零。 */
  readOnly: boolean;
  verification: string[];
  alternatives: string[];
  composesWith: string[];
  /** 同级类似/可替换工具，引导平行探索。 */
  similar: string[];
  /** 本工具之后可继续深入的工具，串成调用链。 */
  deeper: string[];
  availability: CapabilityAvailability;
  source: string;
  metadataComplete: boolean;
};

export type CapabilityMetadata = {
  purpose?: string;
  triggers?: string[];
  outputs?: string[];
  preconditions?: string[];
  risk?: CapabilityRisk;
  readOnly?: boolean;
  verification?: string[];
  alternatives?: string[];
  composesWith?: string[];
  similar?: string[];
  deeper?: string[];
};

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
  verification: string[];
  alternatives: string[];
  composesWith: string[];
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
  verification?: string[];
  alternatives?: string[];
  composesWith?: string[];
};

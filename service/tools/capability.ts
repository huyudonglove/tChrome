import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillManifest, readSkill } from "../skills/loader.ts";
import type { ExecutionMode } from "../types.ts";
import {
  CAPABILITY_RISKS,
  type CapabilityAvailability,
  type CapabilityInput,
  type CapabilityMetadata,
  type CapabilityRecord,
  type CapabilityRisk,
} from "./capability-types.ts";

type ToolSource = {
  tools: Record<string, { function: { name: string; description?: string; parameters?: Record<string, unknown> } }>;
  index: { browser: string[]; service: string[] };
  toolGroups: { baseToolsIds: string[]; coreToolIds: string[] };
  execution: Record<string, ExecutionMode>;
};

type SkillMetadataFile = {
  version: 1;
  tools?: Record<string, CapabilityMetadata>;
  skills?: Record<string, CapabilityMetadata>;
};

const ARRAY_FIELDS = ["triggers", "outputs", "preconditions", "verification", "alternatives", "composesWith", "similar", "deeper"] as const;

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error(`invalid capability metadata ${field}`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function normalizeMetadata(raw: unknown, id: string): CapabilityMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`invalid capability metadata ${id}`);
  const value = raw as Record<string, unknown>;
  if (value.purpose !== undefined && (typeof value.purpose !== "string" || !value.purpose.trim())) {
    throw new Error(`invalid capability metadata ${id}.purpose`);
  }
  if (value.risk !== undefined && (typeof value.risk !== "string" || !CAPABILITY_RISKS.includes(value.risk as CapabilityRisk))) {
    throw new Error(`invalid capability metadata ${id}.risk`);
  }
  const result: CapabilityMetadata = {};
  if (value.purpose !== undefined) result.purpose = value.purpose.trim();
  if (value.risk !== undefined) result.risk = value.risk as CapabilityRisk;
  if (value.readOnly !== undefined) {
    if (typeof value.readOnly !== "boolean") throw new Error(`invalid capability metadata ${id}.readOnly`);
    result.readOnly = value.readOnly;
  }
  for (const field of ARRAY_FIELDS) {
    if (value[field] !== undefined) result[field] = stringList(value[field], `${id}.${field}`);
  }
  return result;
}

function readMetadata(repoRoot: string, knownToolIds: Set<string>, knownSkillIds: Set<string>): Required<Pick<SkillMetadataFile, "tools" | "skills">> {
  const path = join(repoRoot, "service/capabilities/metadata.json");
  if (!existsSync(path)) return { tools: {}, skills: {} };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.version !== 1) throw new Error("invalid capability metadata file");
  const normalizeGroup = (group: unknown, kind: "tools" | "skills") => {
    if (group === undefined) return {};
    if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error(`invalid capability metadata ${kind}`);
    const known = kind === "tools" ? knownToolIds : knownSkillIds;
    const result: Record<string, CapabilityMetadata> = {};
    for (const [id, metadata] of Object.entries(group)) {
      if (!known.has(id)) throw new Error(`unknown ${kind.slice(0, -1)} in capability metadata ${id}`);
      result[id] = normalizeMetadata(metadata, id);
    }
    return result;
  };
  return { tools: normalizeGroup(raw.tools, "tools"), skills: normalizeGroup(raw.skills, "skills") };
}

function firstSentence(description: string, fallback: string): string {
  return description.split(/[。\n]/, 1)[0]!.trim() || fallback;
}

function toolInputs(parameters: Record<string, unknown> | undefined): CapabilityInput[] {
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return [];
  const properties = parameters.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(parameters.required) ? parameters.required.filter((id): id is string => typeof id === "string") : []);
  return Object.entries(properties as Record<string, unknown>).map(([name]) => ({ name, required: required.has(name) }));
}

function toolAvailability(source: ToolSource, id: string): CapabilityAvailability {
  if (source.toolGroups.baseToolsIds.includes(id)) return "base";
  if (source.toolGroups.coreToolIds.includes(id)) return "core";
  if (source.index.browser.includes(id)) return "browser";
  if (source.index.service.includes(id)) return "service";
  throw new Error(`tool ${id} is missing from tool groups`);
}

export function loadCapabilityCatalog(repoRoot: string, source: ToolSource): CapabilityRecord[] {
  const toolIds = new Set(Object.keys(source.tools));
  const manifest = loadSkillManifest(repoRoot);
  const skillIds = new Set([...manifest.residentSkillIds, ...manifest.dynamicSkillIds]);
  const metadata = readMetadata(repoRoot, toolIds, skillIds);
  const records: CapabilityRecord[] = [];

  for (const id of Object.keys(source.tools).sort()) {
    const tool = source.tools[id]!;
    const override = metadata.tools[id] ?? {};
    const purpose = override.purpose ?? firstSentence(tool.function.description ?? "", id);
    records.push({
      id,
      kind: "tool",
      name: id,
      purpose,
      triggers: override.triggers ?? [],
      inputs: toolInputs(tool.function.parameters),
      outputs: override.outputs ?? [],
      preconditions: override.preconditions ?? [],
      risk: override.risk ?? "unknown",
      readOnly: override.readOnly ?? false,
      verification: override.verification ?? [],
      alternatives: override.alternatives ?? [],
      composesWith: override.composesWith ?? [],
      similar: override.similar ?? [],
      deeper: override.deeper ?? [],
      availability: toolAvailability(source, id),
      source: `service/tools/definitions`,
      metadataComplete: Boolean(override.purpose && override.risk && override.triggers?.length && override.verification?.length),
    });
  }

  for (const [kind, ids] of [["skill", manifest.residentSkillIds] as const, ["skill", manifest.dynamicSkillIds] as const]) {
    for (const id of ids) {
      const skill = readSkill(repoRoot, id);
      const override = metadata.skills[id] ?? {};
      const purpose = override.purpose ?? firstSentence(skill.description, id);
      
      records.push({
        id,
        kind,
        name: id,
        purpose,
        triggers: override.triggers ?? [skill.summary],
        inputs: [],
        outputs: override.outputs ?? [],
        preconditions: override.preconditions ?? [],
        risk: override.risk ?? "unknown",
        readOnly: false,
        verification: override.verification ?? [],
        alternatives: override.alternatives ?? [],
        composesWith: override.composesWith ?? [],
        similar: override.similar ?? [],
        deeper: override.deeper ?? [],
        availability: ids === manifest.residentSkillIds ? "resident" : "dynamic",
        source: `service/skills/${id}/SKILL.md`,
        metadataComplete: Boolean(override.purpose && override.risk && override.triggers?.length && override.verification?.length),
      });
    }
  }
  return records.sort((a, b) => a.id.localeCompare(b.id));
}

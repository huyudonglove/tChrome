import { AppError, modelSpeech } from "../../../shared/errors.ts";
import Ajv from "ajv";
import type { ChatMessage, ChatTool, CompletionResult, Provider } from "../../types.ts";
import { unwrapStringArrayField } from "../../tools/arguments.ts";

export const TOOL_RESULT_FORMAT_ATTEMPTS = 3;

/** Compatibility alias retained for callers that already use the old name. */
export const SELECTION_FORMAT_ATTEMPTS = TOOL_RESULT_FORMAT_ATTEMPTS;

export type ToolResultProtocol = {
  /** Human-readable Agent name used only in protocol errors. */
  agentName: string;
  /** Stable error code exposed by the caller. */
  faultCode: string;
  /** System/User prompts. Domain semantics remain outside the reusable core. */
  systemPrompt: string;
  userPrompt: string;
  /** The Agent's only structured return tool. */
  tool: ChatTool;
  /** Exact function name the model must call. */
  toolName: string;
  /** Produce a domain-specific self-repair instruction from the previous fault. */
  repairInstruction: (fault: string) => string;
  /** Optional normalization before JSON-schema validation, for legacy string encodings. */
  normalizeResult?: (value: Record<string, unknown>) => Record<string, unknown>;
  /** Optional domain validation; return an error string to request self-repair. */
  validateResult?: (value: Record<string, unknown>) => string | null;
};



function structuredToolFault(agentName: string, toolName: string, response: CompletionResult): string | null {
  if (response.finish === "error" && response.faultCode) return null;
  if (response.finish !== "tool_calls" || response.toolCalls.length !== 1 || response.faultCode
    || !response.parseOk || !response.schemaOk || response.toolCallFaults?.length || response.missing.length) {
    return response.detail || response.faultCode || "invalid_return_tool_call";
  }
  const call = response.toolCalls[0]!;
  if (call.name !== toolName || typeof call.id !== "string" || !call.id.trim()) {
    return `${agentName} 必须通过一次 ${toolName} 工具调用返回结果。`;
  }
  return null;
}

/**
 * Generic protocol for a tool-class Agent.
 *
 * The caller owns domain input, candidate construction, semantic rules and
 * result expansion. This core owns the model return contract, bounded
 * self-repair, normalization, JSON-schema validation and error closure.
 */
export async function requestToolResult(input: {
  provider: Provider;
  protocol: ToolResultProtocol;
}): Promise<Record<string, unknown>> {
  const protocol = input.protocol;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(protocol.tool.function.parameters);
  const baseMessages: ChatMessage[] = [
    { role: "system", content: protocol.systemPrompt },
    { role: "user", content: protocol.userPrompt },
  ];
  let lastError = "";

  for (let attempt = 1; attempt <= TOOL_RESULT_FORMAT_ATTEMPTS; attempt++) {
    const messages: ChatMessage[] = attempt === 1 ? baseMessages : [
      ...baseMessages,
      {
        role: "user",
        content: JSON.stringify({
          selfRepair: true,
          attempt,
          maxAttempts: TOOL_RESULT_FORMAT_ATTEMPTS,
          fault: modelSpeech(lastError),
          instruction: modelSpeech(protocol.repairInstruction(lastError)),
        }),
      },
    ];
    const response = await input.provider.complete({ tools: [protocol.tool], messages });
    if (response.finish === "error" && response.faultCode) {
      throw new AppError(response.faultCode, `${protocol.agentName} failed: ${response.faultCode}`);
    }

    const protocolFault = structuredToolFault(protocol.agentName, protocol.toolName, response);
    if (protocolFault) lastError = protocolFault;
    else {
      const normalized = protocol.normalizeResult
        ? protocol.normalizeResult(response.toolCalls[0]!.arguments)
        : response.toolCalls[0]!.arguments;
      if (!validate(normalized)) {
        lastError = `${protocol.agentName} 返回的工具参数不符合 schema。`;
      } else {
        const semanticFault = protocol.validateResult?.(normalized) ?? null;
        if (semanticFault) lastError = semanticFault;
        else return normalized;
      }
    }

    if (attempt === TOOL_RESULT_FORMAT_ATTEMPTS) {
      throw new AppError(protocol.faultCode, `${protocol.agentName} format failed after ${TOOL_RESULT_FORMAT_ATTEMPTS} attempts: ${lastError}`);
    }
  }
  throw new AppError(protocol.faultCode, `${protocol.agentName} failed`);
}


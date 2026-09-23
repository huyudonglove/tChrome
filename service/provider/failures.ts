import OpenAI from "openai";
import { HttpIdleTimeoutError } from "../network/idle-fetch.ts";

type FailureKind = "output_limit" | "refused" | "incomplete" | "invalid_response" | "server_error" | "rate_limit";
const policies = {
  output_limit: { faultCode: "provider_output_limit", retryable: false },
  refused: { faultCode: "provider_refused", retryable: false },
  incomplete: { faultCode: "provider_incomplete", retryable: false },
  invalid_response: { faultCode: "provider_invalid_response", retryable: true },
  server_error: { faultCode: "provider_error", retryable: true },
  rate_limit: { faultCode: "provider_error", retryable: true },
} as const;

/** Adapters identify protocol failures; this module alone decides retry policy. */
export class ProviderFailure extends Error {
  constructor(readonly kind: FailureKind, detail: string) { super(detail); this.name = "ProviderFailure"; }
}

/** 网关或 thinking 模式拒绝 tool_choice / functionCallingConfig，可降级 auto 后原样重试。 */
export function isToolChoiceRejection(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /tool_choice|toolChoice|functionCallingConfig/i.test(text);
}

export function classifyProviderFailure(error: unknown): { faultCode: string; retryable: boolean } {
  if (error instanceof ProviderFailure) return policies[error.kind];
  if (error instanceof HttpIdleTimeoutError) return { faultCode: "provider_error", retryable: true };
  if (error instanceof OpenAI.APIUserAbortError) return { faultCode: "stopped", retryable: false };
  if (error instanceof OpenAI.APIConnectionError) return { faultCode: "provider_error", retryable: true };
  const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
  return {
    faultCode: status === 401 ? "provider_key_invalid" : status === 403 ? "provider_forbidden" : "provider_error",
    retryable: status === 408 || status === 429 || (status >= 500 && status <= 599),
  };
}

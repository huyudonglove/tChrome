import { describe, expect, test } from "bun:test";
import catalog from "./error-messages.json";
import { AppError, errorInfo, errorMessage, errorRecovery } from "./errors.ts";

describe("shared errors", () => {
  test("preserves structured errors and their diagnostic details", () => {
    const cause = new Error("disk full");
    const error = new AppError("context_storage_failed", "write failed", { path: "/data" }, { cause });
    expect(error.cause).toBe(cause);
    expect(errorInfo(error)).toEqual({ faultCode: "context_storage_failed", detail: "write failed", details: { path: "/data" } });
    expect(errorInfo({ faultCode: "custom_code", detail: "domain detail", details: { value: 2 } })).toEqual({
      faultCode: "custom_code", detail: "domain detail", details: { value: 2 },
    });
  });

  test("maps platform errors without losing their original messages", () => {
    for (const [code, faultCode] of Object.entries({ ENOENT: "file_not_found", EACCES: "permission_denied", EPERM: "permission_denied", ENOTDIR: "invalid_path", EEXIST: "file_exists" })) {
      expect(errorInfo(Object.assign(new Error("original detail"), { code }))).toEqual({ faultCode, detail: "original detail" });
    }
    expect(errorInfo(new DOMException("cancelled", "AbortError")).faultCode).toBe("stopped");
    expect(errorInfo(Object.assign(new Error("idle"), { name: "HttpIdleTimeoutError" })).faultCode).toBe("http_idle_timeout");
    expect(errorInfo(new Error("unknown"), "query_failed")).toEqual({ faultCode: "query_failed", detail: "unknown" });
  });

  test("unknown errors have safe recovery rather than automatic retry", () => {
    for (const code of ["unknown_future_code", "tool_timeout", "http_idle_timeout", "toString", "__proto__"]) {
      expect(errorRecovery(code)).toBe("inspect_state");
      expect(typeof errorMessage(code, "model")).toBe("string");
    }
    expect(errorInfo("plain error")).toEqual({ faultCode: "tool_execution_failed", detail: "plain error" });
    expect(errorInfo(null).detail).toBe(errorMessage("tool_execution_failed", "model"));
    expect(errorRecovery("stopped")).toBe("none");
    expect(errorRecovery("wrong_type")).toBe("correct_arguments");
    expect(errorInfo({ code: "toString" }).faultCode).toBe("tool_execution_failed");
  });

  test("every catalog entry has both audiences and a valid recovery", () => {
    for (const [code, entry] of Object.entries(catalog)) {
      expect(entry.model.trim().length, code).toBeGreaterThan(0);
      expect(entry.user.trim().length, code).toBeGreaterThan(0);
      expect(["correct_arguments", "inspect_state", "user_action", "retry", "none"]).toContain(entry.recovery);
    }
  });
});

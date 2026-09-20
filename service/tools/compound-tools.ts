import type { BrowserHost } from "../types.ts";

export const COMPOUND_TOOL_NAMES = [
  "page.click_role",
  "page.fill_role",
  "page.submit_wait",
  "page.select_role",
  "page.click_text",
  "page.fill_submit",
] as const;

type HostResult = Record<string, unknown> & {
  ok?: boolean;
  elements?: { id?: string; name?: string; role?: string; text?: string; label?: string }[];
  total?: number;
};

const fail = (tabId: unknown, faultCode: string, message: string, extra: Record<string, unknown> = {}) => ({
  ok: false,
  tabId,
  faultCode,
  message,
  recovery: "correct_arguments",
  ...extra,
});

function pickElement(found: HostResult, matchIndex: number | undefined, sourceLabel: string) {
  const elements = Array.isArray(found.elements) ? found.elements : [];
  const total = typeof found.total === "number" ? found.total : elements.length;
  if (!elements.length) return { error: fail(undefined, "not_found", `${sourceLabel} 未找到匹配控件`, { total: total ?? 0 }) };
  if (typeof matchIndex !== "number" && total > 1) {
    return {
      error: fail(undefined, "ambiguous_target", `匹配到 ${total} 个控件，须提供 matchIndex 指明序号，或收窄定位条件`, {
        total,
        candidates: elements.slice(0, 8).map((el, index) => ({ index, id: el.id, role: el.role, name: el.name, text: el.text, label: el.label })),
      }),
    };
  }
  const index = matchIndex ?? 0;
  if (!Number.isInteger(index) || index < 0 || index >= elements.length) {
    return { error: fail(undefined, "invalid_arguments", `matchIndex 超出范围 0..${elements.length - 1}`, { total }) };
  }
  const el = elements[index]!;
  if (!el.id) return { error: fail(undefined, "not_found", `匹配控件缺少元素编号 id（来自 ${sourceLabel}）`) };
  return { element: el, index };
}

async function optionalWait(
  host: BrowserHost,
  tabId: unknown,
  args: Record<string, unknown>,
  reason: string,
  ms: number | undefined,
): Promise<HostResult | null> {
  if (typeof args.waitText === "string" && args.waitText.trim()) {
    return await host.execute("wait", { tabId, text: args.waitText, ...(ms !== undefined ? { ms } : {}), reason }) as HostResult;
  }
  if (typeof args.waitUrlContains === "string" && args.waitUrlContains.trim()) {
    return await host.execute("wait_response", {
      tabId,
      urlContains: args.waitUrlContains,
      ...(typeof args.status === "number" ? { status: args.status } : {}),
      ...(ms !== undefined ? { ms } : {}),
      reason,
    }) as HostResult;
  }
  return null;
}

async function resolveByRole(host: BrowserHost, tabId: unknown, reason: string, role: string, a11yName: string | undefined, matchIndex: number | undefined) {
  const found = await host.execute("page.get_by_role", {
    tabId,
    role,
    ...(a11yName !== undefined ? { name: a11yName } : {}),
    reason,
  }) as HostResult;
  if (!found?.ok) return { found };
  const picked = pickElement(found, matchIndex, "page.get_by_role");
  if ("error" in picked) return { found, error: picked.error };
  return { found, id: picked.element.id!, index: picked.index };
}

/**
 * Service-side compound browser steps. Each call sequences existing extension
 * Compose page primitives via one host bridge call.
 */
export async function runCompoundTool(
  name: string,
  args: Record<string, unknown>,
  host: BrowserHost,
): Promise<Record<string, unknown>> {
  const tabId = args.tabId;
  const reason = typeof args.reason === "string" ? args.reason : "";
  const ms = typeof args.ms === "number" ? args.ms : undefined;
  const matchIndex = typeof args.matchIndex === "number" ? args.matchIndex : undefined;

  if (name === "page.click_role") {
    const role = String(args.role ?? "");
    const a11yName = typeof args.name === "string" ? args.name : undefined;
    const located = await resolveByRole(host, tabId, reason, role, a11yName, matchIndex);
    if (located.error) return { ...located.error, tabId, role, name: a11yName, step: "page.get_by_role" };
    if (!located.found?.ok) return { ...located.found, step: "page.get_by_role", tabId };
    const id = located.id!;
    const clicked = await host.execute("page.click", { tabId, id, reason }) as HostResult;
    if (!clicked?.ok) return { ...clicked, step: "page.click", tabId, id };
    const wait = await optionalWait(host, tabId, args, reason, ms);
    if (wait && !wait.ok) return { ...wait, step: "wait", tabId, id, clicked: true };
    return { ok: true, tabId, id, role, name: a11yName ?? null, matchIndex: located.index, clicked: true, wait: wait ?? null };
  }

  if (name === "page.fill_role") {
    const role = String(args.role ?? "");
    const a11yName = typeof args.name === "string" ? args.name : undefined;
    const text = String(args.text ?? "");
    const located = await resolveByRole(host, tabId, reason, role, a11yName, matchIndex);
    if (located.error) return { ...located.error, tabId, role, name: a11yName, step: "page.get_by_role" };
    if (!located.found?.ok) return { ...located.found, step: "page.get_by_role", tabId };
    const id = located.id!;
    const typed = await host.execute("page.type", {
      tabId,
      id,
      text,
      ...(args.clearBeforeType === true ? { clearBeforeType: true } : {}),
      ...(args.pressEnter === true ? { pressEnter: true } : {}),
      reason,
    }) as HostResult;
    if (!typed?.ok) return { ...typed, step: "page.type", tabId, id };
    return { ok: true, tabId, id, role, name: a11yName ?? null, matchIndex: located.index, value: typed.value ?? text };
  }

  if (name === "page.submit_wait") {
    const id = String(args.id ?? "");
    const urlContains = String(args.urlContains ?? "");
    const waiting = host.execute("wait_response", {
      tabId,
      urlContains,
      ...(typeof args.status === "number" ? { status: args.status } : {}),
      ...(ms !== undefined ? { ms } : {}),
      reason,
    });
    const clicked = await host.execute("page.click", { tabId, id, reason }) as HostResult;
    if (!clicked?.ok) {
      await Promise.resolve(waiting).catch(() => undefined);
      return { ...clicked, step: "page.click", tabId, id };
    }
    const wait = (await waiting) as HostResult;
    if (!wait?.ok) return { ...wait, step: "wait_response", tabId, id, clicked: true };
    return { ok: true, tabId, id, clicked: true, wait: { ok: true, url: wait.url, status: wait.status, requestId: wait.requestId } };
  }

  if (name === "page.select_role") {
    const role = String(args.role ?? "combobox");
    const a11yName = typeof args.name === "string" ? args.name : undefined;
    const value = String(args.value ?? "");
    const located = await resolveByRole(host, tabId, reason, role, a11yName, matchIndex);
    if (located.error) return { ...located.error, tabId, role, name: a11yName, step: "page.get_by_role" };
    if (!located.found?.ok) return { ...located.found, step: "page.get_by_role", tabId };
    const id = located.id!;
    const selected = await host.execute("combo.select", { tabId, id, value, reason }) as HostResult;
    if (!selected?.ok) return { ...selected, step: "combo.select", tabId, id };
    return { ok: true, tabId, id, role, name: a11yName ?? null, matchIndex: located.index, value: selected.value ?? value, text: selected.text ?? null };
  }

  if (name === "page.click_text") {
    const text = String(args.text ?? "");
    const found = await host.execute("find_on_page", { tabId, text, reason, ...(typeof args.limit === "number" ? { limit: args.limit } : {}) }) as HostResult;
    if (!found?.ok) return { ...found, step: "find_on_page", tabId };
    const picked = pickElement(found, matchIndex, "find_on_page");
    if ("error" in picked) return { ...picked.error, tabId, text, step: "find_on_page" };
    const id = picked.element.id!;
    const clicked = await host.execute("page.click", { tabId, id, reason }) as HostResult;
    if (!clicked?.ok) return { ...clicked, step: "page.click", tabId, id };
    const wait = await optionalWait(host, tabId, args, reason, ms);
    if (wait && !wait.ok) return { ...wait, step: "wait", tabId, id, clicked: true };
    return { ok: true, tabId, id, text, matchIndex: picked.index, clicked: true, wait: wait ?? null };
  }

  if (name === "page.fill_submit") {
    const fields = Array.isArray(args.fields) ? args.fields : [];
    if (!fields.length) return fail(tabId, "invalid_arguments", "fields 不能为空数组");
    const filled: { index: number; role: string; name: string | null; id: string; value: unknown }[] = [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] as Record<string, unknown>;
      const role = String(field.role ?? "");
      const a11yName = typeof field.name === "string" ? field.name : undefined;
      const text = String(field.text ?? "");
      const located = await resolveByRole(host, tabId, reason, role, a11yName, typeof field.matchIndex === "number" ? field.matchIndex : undefined);
      if (located.error) return { ...located.error, tabId, step: "page.get_by_role", fieldIndex: i, role, name: a11yName };
      if (!located.found?.ok) return { ...located.found, tabId, step: "page.get_by_role", fieldIndex: i, role, name: a11yName };
      const typed = await host.execute("page.type", {
        tabId,
        id: located.id,
        text,
        ...(field.clearBeforeType === true ? { clearBeforeType: true } : {}),
        ...(field.pressEnter === true ? { pressEnter: true } : {}),
        reason,
      }) as HostResult;
      if (!typed?.ok) return { ...typed, step: "page.type", tabId, fieldIndex: i, id: located.id };
      filled.push({ index: i, role, name: a11yName ?? null, id: located.id!, value: typed.value ?? text });
    }

    const submit = (args.submit && typeof args.submit === "object" ? args.submit : {}) as Record<string, unknown>;
    let submitId: string;
    if (typeof submit.id === "string" && submit.id.trim()) {
      submitId = submit.id.trim();
    } else if (typeof submit.role === "string" && submit.role.trim()) {
      const located = await resolveByRole(
        host,
        tabId,
        reason,
        submit.role.trim(),
        typeof submit.name === "string" ? submit.name : undefined,
        typeof submit.matchIndex === "number" ? submit.matchIndex : undefined,
      );
      if (located.error) return { ...located.error, tabId, step: "page.get_by_role", filled };
      if (!located.found?.ok) return { ...located.found, tabId, step: "page.get_by_role", filled };
      submitId = located.id!;
    } else {
      return fail(tabId, "invalid_arguments", "submit 必须提供 id 或 role", { filled });
    }

    const waitArgs: Record<string, unknown> = {};
    if (typeof submit.waitUrlContains === "string" && submit.waitUrlContains.trim()) waitArgs.waitUrlContains = submit.waitUrlContains.trim();
    if (typeof submit.waitText === "string" && submit.waitText.trim()) waitArgs.waitText = submit.waitText.trim();
    if (typeof submit.status === "number") waitArgs.status = submit.status;
    if (typeof submit.ms === "number") waitArgs.ms = submit.ms;
    const hasWait = typeof waitArgs.waitUrlContains === "string" || typeof waitArgs.waitText === "string";

    if (typeof waitArgs.waitUrlContains === "string") {
      const waiting = host.execute("wait_response", {
        tabId,
        urlContains: waitArgs.waitUrlContains,
        ...(typeof waitArgs.status === "number" ? { status: waitArgs.status } : {}),
        ...(typeof waitArgs.ms === "number" ? { ms: waitArgs.ms } : {}),
        reason,
      });
      const clicked = await host.execute("page.click", { tabId, id: submitId, reason }) as HostResult;
      if (!clicked?.ok) {
        await Promise.resolve(waiting).catch(() => undefined);
        return { ...clicked, step: "page.click", tabId, id: submitId, filled };
      }
      const wait = (await waiting) as HostResult;
      if (!wait?.ok) return { ...wait, step: "wait_response", tabId, id: submitId, filled, clicked: true };
      return { ok: true, tabId, filled, submit: { id: submitId, clicked: true }, wait: { ok: true, url: wait.url, status: wait.status, requestId: wait.requestId } };
    }

    const clicked = await host.execute("page.click", { tabId, id: submitId, reason }) as HostResult;
    if (!clicked?.ok) return { ...clicked, step: "page.click", tabId, id: submitId, filled };
    const wait = hasWait ? await optionalWait(host, tabId, waitArgs, reason, ms) : null;
    if (wait && !wait.ok) return { ...wait, step: "wait", tabId, id: submitId, filled, clicked: true };
    return { ok: true, tabId, filled, submit: { id: submitId, clicked: true }, wait: wait ?? null };
  }

  return fail(tabId, "unknown_tool", `未知复合工具 ${name}`);
}

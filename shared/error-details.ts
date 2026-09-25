/** Central catalog for tool/detail diagnostics (not faultCode message policy).
 * message/recovery stay in error-messages.json; this file only owns detail/reason text
 * so call sites never hardcode Chinese prompts that are easy to miss when editing.
 * Placeholders use {name}; unknown keys return a safe English fallback.
 */
import detailsJson from "./error-details.json" with { type: "json" };

const catalog = detailsJson as Record<string, string>;

export type DetailKey = keyof typeof catalog & string;

export function errorDetail(key: string, params?: Record<string, string | number>): string {
  const template = Object.hasOwn(catalog, key) ? catalog[key]! : `detail:${key}`;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole);
}

import catalog from "./catalog.json";

export type IdentityKind = keyof typeof catalog;
export const idPrefix = (kind: IdentityKind) => `${catalog[kind].prefix}_`;
export const identitySchema = {
  $id: "tchrome:identity",
  $defs: Object.fromEntries(Object.entries(catalog).map(([kind, item]) => [kind, {
    type: "string", pattern: `^${item.prefix}_[0-9]{2,}$`,
  }])),
};
export const identityRulesText = () => [
  "| 记录 | 示例 | 编号范围 |",
  "| --- | --- | --- |",
  ...Object.values(catalog).map(item =>
    `| ${item.description} | ${item.prefix}_01 | ${item.scope === "service" ? "服务" : "会话"} |`),
].join("\n");
export { catalog };

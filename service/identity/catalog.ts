import catalog from "./catalog.json";

export type IdentityKind = keyof typeof catalog;
export const idPrefix = (kind: IdentityKind) => `${catalog[kind].prefix}_`;
export const identitySchema = {
  $id: "tchrome:identity",
  $defs: Object.fromEntries(Object.entries(catalog).map(([kind, item]) => [kind, {
    type: "string", pattern: `^${item.prefix}_[0-9]{2,}$`,
  }])),
};
export { catalog };

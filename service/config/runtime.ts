import config from "./runtime.json";

// Fail at startup instead of silently disabling a deadline with an invalid value.
for (const [group, values] of Object.entries(config)) {
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid runtime configuration: ${group}.${key}`);
  }
  Object.freeze(values);
}
export const runtimeConfig = Object.freeze(config);

import config from "./runtime.json";

const envInt = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

// Tests set TCHROME_RETRY_DELAY_MS=1 via preload so retry loops stay fast.
const resolved = {
  ...config,
  network: {
    ...config.network,
    ...(envInt("TCHROME_RETRY_DELAY_MS") !== undefined ? { retryDelayMs: envInt("TCHROME_RETRY_DELAY_MS")! } : {}),
    ...(envInt("TCHROME_MAX_ATTEMPTS") !== undefined ? { maxAttempts: envInt("TCHROME_MAX_ATTEMPTS")! } : {}),
  },
};

// Fail at startup instead of silently disabling a deadline with an invalid value.
for (const [group, values] of Object.entries(resolved)) {
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid runtime configuration: ${group}.${key}`);
  }
  Object.freeze(values);
}
export const runtimeConfig = Object.freeze(resolved);

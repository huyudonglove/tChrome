// Speed up provider/network retry loops in `bun test` without changing production defaults.
if (process.env.TCHROME_RETRY_DELAY_MS === undefined) {
  process.env.TCHROME_RETRY_DELAY_MS = "1";
}

import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { join } from "node:path";

test("sidepanel network entry initializes in a browser without Node globals", async () => {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "service.ts")],
    target: "browser", format: "iife",
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]!.text();
  // A browser build can succeed while replacing node:async_hooks with an empty
  // module. Evaluate the emitted code to catch constructor failures at startup.
  expect(() => runInNewContext(bundle, { URL, Request, Response, AbortController, TextEncoder, TextDecoder, setTimeout, clearTimeout })).not.toThrow();
});

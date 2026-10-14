import { describe, expect, it } from "vitest";

import manifest from "../package.json";

/**
 * tsup emits `index.d.ts` for the ESM build and `index.d.cts` for the CJS one.
 * With a single top-level `types` condition both resolved to `index.d.ts`, and
 * because the package is `"type": "module"` TypeScript reads that file as ESM:
 * a CommonJS consumer on `module: node16` got TS1479 on a plain import, though
 * the runtime `require` worked. Each condition carries its own types.
 */
describe("package exports", () => {
  it("gives CommonJS consumers the .d.cts types and ESM consumers the .d.ts", () => {
    expect((manifest.exports as Record<string, unknown>)["."]).toEqual({
      import: { types: "./dist/index.d.ts", default: "./dist/index.js" },
      require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
    });
  });
});

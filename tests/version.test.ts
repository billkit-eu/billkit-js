import { describe, expect, it } from "vitest";

import manifest from "../package.json";
import { VERSION } from "../src/version.js";

/**
 * The version is written down twice: `package.json` is what npm publishes, and
 * `src/version.ts` is the exported `VERSION`, which `iframe.ts` sends to the
 * checkout iframe as `loaderVersion` on every mount.
 *
 * The release gate only checks the tag against `package.json`, so without this
 * test a bump that misses `src/version.ts` publishes cleanly while every
 * element identifies itself to the payment frame as the previous release.
 *
 * Imported rather than read off disk because this suite runs under jsdom, where
 * `import.meta.url` is an http: URL and `fileURLToPath` throws.
 */
describe("version", () => {
  it("matches the version in package.json", () => {
    expect(VERSION).toBe(manifest.version);
  });
});

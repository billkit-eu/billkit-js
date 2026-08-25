import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Browser SDK: ES2020 baseline (task spec), no Node built-ins.
  target: "es2020",
  platform: "browser",
  minify: false,
  treeshake: true,
});

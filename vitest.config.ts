import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser SDK: DOM + postMessage need a jsdom environment.
    environment: "jsdom",
    globals: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});

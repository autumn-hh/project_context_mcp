import { defineConfig } from "vitest/config";
import { timeout } from "./tests/helpers/timeouts.js";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    testTimeout: timeout(15_000),
    hookTimeout: timeout(10_000),
  },
});

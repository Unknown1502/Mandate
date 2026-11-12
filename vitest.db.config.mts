import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** DB integration tests: real PostgreSQL (the `mandate_test` database), no PayPal, no LLM. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["tests/db/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/db/setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});

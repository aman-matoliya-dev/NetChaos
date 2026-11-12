import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Type-only declarations contain no executable code.
      exclude: ["src/types/**"],
      reporter: ["text", "html"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});

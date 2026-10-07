import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests cover the pure domain logic (slotting, runway, cooldowns, approval
// rules, deal stages) and the Worker's request handling against stubs. They
// need no accounts and no network, so they run on every change in under a minute.
export default defineConfig({
  resolve: {
    alias: {
      "@app": fileURLToPath(new URL("./app", import.meta.url)),
      "@shared": fileURLToPath(new URL("./shared", import.meta.url)),
      "@worker": fileURLToPath(new URL("./worker", import.meta.url)),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});

import { defineConfig } from "vitest/config";

// Grading tests launch Chromium; the first run also downloads a MongoDB binary.
export default defineConfig({ test: { testTimeout: 120_000, hookTimeout: 600_000 } });

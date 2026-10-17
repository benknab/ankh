import { presets, recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["*_test.ts"],
    // Integration tests exercise real subprocesses and the ten-second drive-lock retry.
    testTimeout: 120_000,
  },
  lint: {
    ...recommended,
    options: { typeAware: true },
    rules: {
      // Keep opt-in Effect rules off, including under Oxlint's default categories.
      ...Object.fromEntries(
        Object.keys({
          ...presets.antipattern.rules,
          ...presets.correctness.rules,
          ...presets.effectNative.rules,
          ...presets.maintainers.rules,
          ...presets.style.rules,
        }).map((name) => [name, "off"] as const),
      ),
      ...recommended.rules,
    },
  },
});

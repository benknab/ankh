import { presets, recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml"],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/**/*.unit.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/**/*.integration.test.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
    ],
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
      "effecttsgo/unstable-api-usage": "off",
      "effecttsgo/global-date": "error",
      "effecttsgo/global-date-in-effect": "error",
      "effecttsgo/global-timers": "error",
      "effecttsgo/global-timers-in-effect": "error",
      "no-restricted-globals": [
        "error",
        { name: "Date", message: "Use Clock-backed DateTime effects and DateTime parsing." },
        { name: "performance", message: "Use Effect Clock for elapsed time." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "process", property: "hrtime", message: "Use Effect Clock for elapsed time." },
        {
          object: "DateTime",
          property: "nowUnsafe",
          message: "Use DateTime.now so time comes from Effect Clock.",
        },
        {
          object: "DateTime",
          property: "isFutureUnsafe",
          message: "Use DateTime.isFuture so time comes from Effect Clock.",
        },
        {
          object: "DateTime",
          property: "isPastUnsafe",
          message: "Use DateTime.isPast so time comes from Effect Clock.",
        },
      ],
    },
  },
});

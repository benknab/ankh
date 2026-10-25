import { presets, recommended } from "@effect/tsgo/oxlint-presets";
import { Record } from "effect";
import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["pnpm-lock.yaml"],
  },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["src/**/*.unit.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "integration",
          fsModuleCache: false,
          include: ["src/**/*.integration.test.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
        },
      },
    ],
  },
  lint: {
    ...recommended,
    env: { node: true, es2024: true },
    plugins: [
      "eslint",
      "typescript",
      "oxc",
      "unicorn",
      "import",
      "promise",
      "vitest",
      "node",
      "effecttsgo",
    ],
    categories: {
      correctness: "error",
      suspicious: "error",
      pedantic: "error",
      perf: "error",
      restriction: "error",
      style: "off",
    },
    options: { typeAware: true, typeCheck: true, reportUnusedDisableDirectives: "error" },
    rules: {
      ...Record.map(
        {
          ...presets.antipattern.rules,
          ...presets.correctness.rules,
          ...presets.effectNative.rules,
          ...presets.maintainers.rules,
          ...presets.style.rules,
        },
        () => "error" as const,
      ),
      // The native platform, HTTP, CLI, and process APIs are required by this app.
      "effecttsgo/unstable-api-usage": "off",
      "effecttsgo/api-stability-leak": "off",
      // Prefer barrel imports consistently; namespace imports conflict with this rule.
      "effecttsgo/prefer-namespace-import": "off",
      // Application operations are not a public dual/data-last library API.
      "effecttsgo/missing-pipeable-signature": "off",
      "effecttsgo/missed-pipeable-opportunity": "off",
      "eslint/complexity": "error",
      "eslint/max-depth": "error",
      "eslint/max-lines": "error",
      "eslint/max-lines-per-function": "error",
      "eslint/max-nested-callbacks": "error",
      "eslint/max-params": "error",
      "eslint/max-statements": "error",
      // Declarative Schema/Layer composition is not control-flow nesting.
      "unicorn/max-nested-calls": "off",
      "typescript/consistent-type-imports": "error",
      "typescript/consistent-type-exports": "error",
      "typescript/explicit-function-return-type": "error",
      "typescript/explicit-module-boundary-types": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/strict-boolean-expressions": "error",
      "typescript/switch-exhaustiveness-check": "error",
      // Type/value names and optional undefined fields are normal TypeScript.
      "eslint/no-redeclare": "off",
      "eslint/no-undefined": "off",
      // File permission masks require bitwise AND.
      "eslint/no-bitwise": ["error", { allow: ["&"] }],
      // Removing undefined changes the arity of Effect's dual functions.
      "unicorn/no-useless-undefined": "off",
      "typescript/no-invalid-void-type": ["error", { allowInGenericTypeArguments: true }],
      // Yieldable failures return never; TypeScript checks generator returns.
      "typescript/consistent-return": "off",
      // Effect capabilities and URL have methods; deep readonly rejects these APIs.
      "typescript/prefer-readonly-parameter-types": "off",
      // Exhaustiveness is checked from the discriminated union, not a fallback.
      "eslint/default-case": "off",
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      // Named exports and modern syntax keep service dependencies explicit.
      "import/no-named-export": "off",
      "import/prefer-default-export": "off",
      "oxc/no-rest-spread-properties": "off",
      "oxc/no-optional-chaining": "off",
      // Effect factories are capitalized; tagged errors are not native Error.
      "unicorn/throw-new-error": "off",
      "unicorn/no-array-method-this-argument": "off",
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["it.effect", "it.effect.each", "it.live"] },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: ["./*", "../*"],
          paths: [
            { name: "@effect/vitest", importNames: ["assert"], message: "Use expect matchers." },
          ],
        },
      ],
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
    overrides: [
      {
        files: ["vite.config.ts"],
        rules: { "import/no-default-export": "off" },
      },
      {
        files: ["src/main.ts", "**/*.test.ts"],
        // These are runtime entry points and tests own their layer scopes.
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
      {
        files: ["src/**/*.ts", "vite.config.ts"],
        excludeFiles: ["**/*.test.ts"],
        rules: { "vitest/require-hook": "off" },
      },
      {
        files: ["**/*.test.ts"],
        rules: {
          "eslint/max-lines": "off",
          "eslint/max-lines-per-function": "off",
          "eslint/max-statements": "off",
          "import/max-dependencies": "off",
          // Effect test scopes replace hooks. Exact booleans retain stronger checks.
          "vitest/require-hook": "off",
          "vitest/no-importing-vitest-globals": "off",
          "vitest/prefer-to-be-truthy": "off",
          "vitest/prefer-to-be-falsy": "off",
        },
      },
    ],
  },
});

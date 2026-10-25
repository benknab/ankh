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
      // Enable every Effect preset rule as an error, then apply exceptions below.
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

      // Effect API exceptions.
      // The native platform, HTTP, CLI, and process APIs are required by this app.
      "effecttsgo/unstable-api-usage": "off",
      "effecttsgo/api-stability-leak": "off",

      // App operations do not need both data-first and pipeable signatures.
      "effecttsgo/missing-pipeable-signature": "off",
      "effecttsgo/missed-pipeable-opportunity": "off",

      // Size and complexity limits use the lint defaults.
      "eslint/complexity": "error",
      "eslint/max-depth": "error",
      "eslint/max-lines": "error",
      "eslint/max-lines-per-function": "error",
      "eslint/max-nested-callbacks": "error",
      "eslint/max-params": "error",
      "eslint/max-statements": "error",

      // Declarative Schema/Layer composition is not control-flow nesting.
      "unicorn/max-nested-calls": "off",

      // Explicit types and exhaustive control flow.
      "typescript/explicit-function-return-type": "error",
      "typescript/explicit-module-boundary-types": "error",
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/strict-boolean-expressions": "error",
      "typescript/switch-exhaustiveness-check": "error",

      // TypeScript allows a type and value to share a name, and explicit undefined.
      "eslint/no-redeclare": "off",
      "eslint/no-undefined": "off",

      // Effect API compatibility.
      // Removing undefined changes the arity of Effect's dual functions.
      "unicorn/no-useless-undefined": "off",

      // Effect<void> and similar generic result types are valid.
      "typescript/no-invalid-void-type": ["error", { allowInGenericTypeArguments: true }],

      // Yieldable failures return never; TypeScript checks generator returns.
      "typescript/consistent-return": "off",

      // Effect capabilities and URL have methods; deep readonly rejects these APIs.
      "typescript/prefer-readonly-parameter-types": "off",

      // Exhaustiveness is checked from the discriminated union, not a fallback.
      "eslint/default-case": "off",

      // Tagged errors use _tag and Schema factories rather than native Error.
      "eslint/no-underscore-dangle": ["error", { allow: ["_tag"] }],
      "unicorn/throw-new-error": "off",

      // Effect Array functions take callbacks where native methods take thisArg.
      "unicorn/no-array-method-this-argument": "off",

      // Imports and exports: named exports, explicit type imports, and # paths.
      "typescript/consistent-type-imports": "error",
      "typescript/consistent-type-exports": "error",
      "effecttsgo/prefer-namespace-import": "off",
      "import/no-named-export": "off",
      "import/prefer-default-export": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: ["./*", "../*"],
          paths: [
            { name: "@effect/vitest", importNames: ["assert"], message: "Use expect matchers." },
          ],
        },
      ],

      // Allow modern syntax and bitwise AND for file permission masks.
      "oxc/no-rest-spread-properties": "off",
      "oxc/no-optional-chaining": "off",
      "eslint/no-bitwise": ["error", { allow: ["&"] }],

      // Recognize Effect's Vitest test functions as valid expect scopes.
      "vitest/no-standalone-expect": [
        "error",
        { additionalTestBlockFunctions: ["it.effect", "it.effect.each", "it.live"] },
      ],

      // Read time through Effect Clock so tests can control it.
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
        // Vite requires a default config export.
        files: ["vite.config.ts"],
        rules: { "import/no-default-export": "off" },
      },
      {
        files: ["src/main.ts", "**/*.test.ts"],
        // These are runtime entry points and tests own their layer scopes.
        rules: { "effecttsgo/strict-effect-provide": "off" },
      },
      {
        // Test hooks do not apply to application code or tool configuration.
        files: ["src/**/*.ts", "vite.config.ts"],
        excludeFiles: ["**/*.test.ts"],
        rules: { "vitest/require-hook": "off" },
      },
      {
        files: ["**/*.test.ts"],
        rules: {
          // Test scenarios may be longer and use more dependencies than app code.
          "eslint/max-lines": "off",
          "eslint/max-lines-per-function": "off",
          "eslint/max-statements": "off",
          "import/max-dependencies": "off",

          // Effect test scopes replace hooks; @effect/vitest supplies test helpers.
          "vitest/require-hook": "off",
          "vitest/no-importing-vitest-globals": "off",

          // Check exact booleans rather than accepting any truthy or falsy value.
          "vitest/prefer-to-be-truthy": "off",
          "vitest/prefer-to-be-falsy": "off",
        },
      },
    ],
  },
});

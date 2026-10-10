import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["*_test.ts"],
    // Integration tests exercise real subprocesses and the ten-second drive-lock retry.
    testTimeout: 120_000,
  },
  lint: {
    options: { typeAware: true },
  },
});

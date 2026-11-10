import {defineConfig} from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/test/**/*.test.ts"],
          exclude: ["packages/e2e/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "e2e",
          include: ["packages/e2e/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 300_000,
          poolOptions: {forks: {singleFork: true}},
          pool: "forks",
        },
      },
    ],
  },
});

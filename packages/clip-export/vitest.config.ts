import { defineConfig } from "vitest/config";

// Test chạy ffmpeg thật trên video sinh bằng lavfi: vài giây mỗi ca.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
  },
});

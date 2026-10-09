import { defineConfig } from "vitest/config";

// Không DOM: document phải đọc được ở server (export trên Modal, route API).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

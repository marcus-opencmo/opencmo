import { defineConfig } from "vitest/config";

// Môi trường `node`, không jsdom: core phải chạy được trên server (route
// `/api/v1/editor/ops`), nên test ở đây cũng không được có DOM để dựa vào.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

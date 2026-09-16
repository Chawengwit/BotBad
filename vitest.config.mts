import { defineConfig } from "vitest/config";

export default defineConfig({
  // อ่าน paths จาก tsconfig.json จะได้ไม่ต้องประกาศ alias ซ้ำสองที่
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});

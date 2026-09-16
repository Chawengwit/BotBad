import { createSql, type Sql } from "@/lib/db";

/**
 * เทสที่แตะฐานข้อมูลจริงจะรันเฉพาะเมื่อชี้ไป schema สำหรับเทสเท่านั้น
 * กันไม่ให้เผลอลบข้อมูลใน schema public
 */
export const TEST_SCHEMA = "bot_test";

function loadLocalEnv(): void {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // ไม่มีไฟล์ก็ไม่เป็นไร อาจตั้ง env มาจากข้างนอกแล้ว
  }
}

/** true เมื่อมี DATABASE_URL และสั่งให้ใช้ schema เทสจริง ๆ */
export function canRunDbTests(): boolean {
  loadLocalEnv();
  return Boolean(process.env.DATABASE_URL) && process.env.DB_SCHEMA === TEST_SCHEMA;
}

export function createTestSql(): Sql {
  loadLocalEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("ไม่มี DATABASE_URL");
  if (process.env.DB_SCHEMA !== TEST_SCHEMA) {
    throw new Error(`เทสต้องรันด้วย DB_SCHEMA=${TEST_SCHEMA} เท่านั้น`);
  }
  return createSql(url, TEST_SCHEMA);
}

/** ชื่อไม่ซ้ำกันในแต่ละรอบเทส จะได้ไม่ชนกันเองและตามลบได้ง่าย */
export function testLineUserId(): string {
  return `U-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByLineId, upsertUser } from "@/repositories/user.repository";
import type { Sql } from "@/lib/db";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

// รันด้วย npm run test:db (ต้องรัน migration ลง schema bot_test ก่อน)
describe.skipIf(!canRunDbTests())("user repository (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const created: string[] = [];

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    if (created.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${created})`;
    }
    await sql.end({ timeout: 5 });
  });

  it("สร้างผู้ใช้ใหม่ได้", async () => {
    const lineUserId = testLineUserId();
    created.push(lineUserId);

    const user = await upsertUser(lineUserId, "เชวง", sql);

    expect(user.line_user_id).toBe(lineUserId);
    expect(user.display_name).toBe("เชวง");
    expect(user.id).toMatch(/^\d+$/); // BIGSERIAL คืนมาเป็น string
  });

  it("เรียกซ้ำแล้วอัปเดตชื่อ ไม่สร้างแถวใหม่", async () => {
    const lineUserId = testLineUserId();
    created.push(lineUserId);

    const first = await upsertUser(lineUserId, "ชื่อเดิม", sql);
    const second = await upsertUser(lineUserId, "ชื่อใหม่", sql);

    expect(second.id).toBe(first.id);
    expect(second.display_name).toBe("ชื่อใหม่");

    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM users WHERE line_user_id = ${lineUserId}
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("หาไม่เจอคืน null", async () => {
    expect(await findUserByLineId(testLineUserId(), sql)).toBeNull();
  });

  it("เก็บชื่อภาษาไทยและอีโมจิได้ครบ", async () => {
    const lineUserId = testLineUserId();
    created.push(lineUserId);

    const name = "เชวง 🏸 ก๊วนแบด";
    await upsertUser(lineUserId, name, sql);

    expect((await findUserByLineId(lineUserId, sql))?.display_name).toBe(name);
  });
});

import { getSql, type Sql } from "@/lib/db";
import type { UserRow } from "./types";

/**
 * บันทึกผู้ใช้ LINE ถ้ามีอยู่แล้วให้อัปเดตชื่อที่แสดง
 * เรียกได้ทุกครั้งที่มี event เข้ามา ชื่อใน LINE เปลี่ยนได้ตลอด
 */
export async function upsertUser(
  lineUserId: string,
  displayName: string,
  sql: Sql = getSql(),
): Promise<UserRow> {
  const rows = await sql<UserRow[]>`
    INSERT INTO users (line_user_id, display_name)
    VALUES (${lineUserId}, ${displayName})
    ON CONFLICT (line_user_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          updated_at = now()
    RETURNING id, line_user_id, display_name
  `;

  const user = rows[0];
  if (!user) throw new Error("upsertUser returned no row");
  return user;
}

export async function findUserByLineId(
  lineUserId: string,
  sql: Sql = getSql(),
): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT id, line_user_id, display_name
    FROM users
    WHERE line_user_id = ${lineUserId}
  `;

  return rows[0] ?? null;
}

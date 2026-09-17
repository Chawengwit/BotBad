import { getSql, type Queryable } from "@/lib/db";
import type { LineUserRow, UserRow } from "./types";

/**
 * บันทึกผู้ใช้ LINE ถ้ามีอยู่แล้วให้อัปเดตชื่อที่แสดง
 * เรียกได้ทุกครั้งที่มี event เข้ามา ชื่อใน LINE เปลี่ยนได้ตลอด
 */
export async function upsertUser(
  lineUserId: string,
  displayName: string,
  sql: Queryable = getSql(),
): Promise<LineUserRow> {
  const rows = await sql<LineUserRow[]>`
    INSERT INTO users (line_user_id, display_name)
    VALUES (${lineUserId}, ${displayName})
    ON CONFLICT (line_user_id) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          updated_at = now()
    RETURNING id, line_user_id, line_group_id, display_name
  `;

  const user = rows[0];
  if (!user) throw new Error("upsertUser returned no row");
  return user;
}

export async function findUserByLineId(
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT id, line_user_id, line_group_id, display_name
    FROM users
    WHERE line_user_id = ${lineUserId}
  `;

  return rows[0] ?? null;
}

export async function findUserById(
  id: string,
  sql: Queryable = getSql(),
): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT id, line_user_id, line_group_id, display_name
    FROM users
    WHERE id = ${id}
  `;
  return rows[0] ?? null;
}

/**
 * แขกของกลุ่ม ชื่อเดิมได้แถวเดิมเสมอ (PRP guests-split-bills-and-digest §4.1)
 * ประวัติการลงชื่อและการจ่ายเงินของแขกจึงตามตัวไปทุกรอบ
 */
export async function upsertGuest(
  lineGroupId: string,
  displayName: string,
  sql: Queryable = getSql(),
): Promise<UserRow> {
  const rows = await sql<UserRow[]>`
    INSERT INTO users (line_group_id, display_name)
    VALUES (${lineGroupId}, ${displayName})
    ON CONFLICT (line_group_id, display_name) WHERE line_user_id IS NULL DO UPDATE
      SET updated_at = now()
    RETURNING id, line_user_id, line_group_id, display_name
  `;

  const guest = rows[0];
  if (!guest) throw new Error("upsertGuest returned no row");
  return guest;
}

/**
 * คนในกลุ่มนี้ที่ชื่อตรงกับที่พิมพ์มา
 *
 * บอทดึงรายชื่อสมาชิกจาก LINE ไม่ได้ (ต้องเป็นบัญชี verified/premium) จึงรู้จักเฉพาะ
 *   - แขกของกลุ่มนี้
 *   - สมาชิกที่เคยลงชื่อในรอบของกลุ่มนี้มาก่อน
 * คืนมาหลายแถวได้ ผู้เรียกเป็นคนตัดสินว่าจะถามกลับหรือใช้เลย (PRP §4.4)
 */
export async function findPeopleByName(
  lineGroupId: string,
  displayName: string,
  sql: Queryable = getSql(),
): Promise<UserRow[]> {
  return sql<UserRow[]>`
    SELECT u.id, u.line_user_id, u.line_group_id, u.display_name
    FROM users u
    WHERE lower(btrim(u.display_name)) = lower(btrim(${displayName}))
      AND (
        u.line_group_id = ${lineGroupId}
        OR EXISTS (
          SELECT 1
          FROM game_players gp
          JOIN games g ON g.id = gp.game_id
          WHERE gp.user_id = u.id AND g.line_group_id = ${lineGroupId}
        )
      )
    -- แขกของกลุ่มมาก่อน เพราะเจาะจงกว่าสมาชิกที่บังเอิญชื่อซ้ำ
    ORDER BY (u.line_group_id IS NOT NULL) DESC, u.id
  `;
}

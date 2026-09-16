import { getSql, type Queryable } from "@/lib/db";

export type SessionMessage = { role: "user" | "model"; text: string };

/** เก็บบริบทไว้สั้น ๆ พอให้คุยต่อเนื่อง (LLM Design §10) */
export const SESSION_TTL = "10 minutes";
export const SESSION_MAX_MESSAGES = 10;

export async function loadSessionMessages(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<SessionMessage[]> {
  const rows = await sql<{ messages: SessionMessage[] }[]>`
    SELECT messages
    FROM conversation_sessions
    WHERE line_group_id = ${lineGroupId}
      AND line_user_id = ${lineUserId}
      AND expires_at > now()
  `;

  const messages = rows[0]?.messages;
  return Array.isArray(messages) ? messages : [];
}

export async function saveSessionMessages(
  lineGroupId: string,
  lineUserId: string,
  messages: SessionMessage[],
  sql: Queryable = getSql(),
): Promise<void> {
  const trimmed = messages.slice(-SESSION_MAX_MESSAGES);

  // เก็บกวาดของหมดอายุไปด้วยเลย จะได้ไม่ต้องมี cron แยก
  await sql`DELETE FROM conversation_sessions WHERE expires_at < now()`;

  await sql`
    INSERT INTO conversation_sessions (line_group_id, line_user_id, messages, expires_at)
    VALUES (
      ${lineGroupId},
      ${lineUserId},
      ${sql.json(trimmed)},
      now() + ${SESSION_TTL}::interval
    )
    ON CONFLICT (line_group_id, line_user_id) DO UPDATE
      SET messages = EXCLUDED.messages,
          expires_at = EXCLUDED.expires_at,
          updated_at = now()
  `;
}

/** ล้างเมื่อจบเรื่องแล้ว เช่น ยืนยันสำเร็จ หรือใช้คำสั่งตรงตัว (LLM Design §10) */
export async function clearSession(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    DELETE FROM conversation_sessions
    WHERE line_group_id = ${lineGroupId} AND line_user_id = ${lineUserId}
  `;
}

/**
 * โหมดฟัง (spec §6)
 *
 * หลังมีคนเรียก "บอทจ๋า" บอทจะยอมรับข้อความถัดไป "ของคนนั้น ในกลุ่มนั้น" โดยไม่ต้องมีคำเรียกอีก
 * หน้าต่างสั้นโดยตั้งใจ เพราะระหว่างนี้บอทมีสิทธิ์ตอบแทรกวงสนทนาของกลุ่ม
 */
export const LISTENING_TTL = "2 minutes";

/** เปิดหรือต่ออายุโหมดฟัง แถวอาจยังไม่มีถ้ายังไม่เคยคุยกัน จึง upsert */
export async function openListeningWindow(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    INSERT INTO conversation_sessions (line_group_id, line_user_id, messages, expires_at, listening_until)
    VALUES (
      ${lineGroupId},
      ${lineUserId},
      ${sql.json([])},
      now() + ${SESSION_TTL}::interval,
      now() + ${LISTENING_TTL}::interval
    )
    ON CONFLICT (line_group_id, line_user_id) DO UPDATE
      SET listening_until = now() + ${LISTENING_TTL}::interval,
          -- ยืดอายุแถวให้คลุมโหมดฟังเสมอ ไม่งั้นการเก็บกวาดใน saveSessionMessages
          -- (ซึ่งลบแถวหมดอายุของทุกคน) อาจลบแถวนี้ทิ้งทั้งที่โหมดฟังยังเปิดอยู่
          expires_at = GREATEST(
            conversation_sessions.expires_at,
            now() + ${LISTENING_TTL}::interval
          ),
          updated_at = now()
  `;
}

/** ปิดโหมดฟังแต่เก็บ history ไว้ เผื่อผู้ใช้เรียกบอทอีกครั้งในเรื่องเดิม */
export async function closeListeningWindow(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    UPDATE conversation_sessions
    SET listening_until = NULL, updated_at = now()
    WHERE line_group_id = ${lineGroupId} AND line_user_id = ${lineUserId}
  `;
}

/** เรียกครั้งเดียวจบหลังบอทตอบ จะได้ไม่ต้องเขียน if เปิด/ปิดกระจายทุกที่ */
export async function setListeningWindow(
  lineGroupId: string,
  lineUserId: string,
  open: boolean,
  sql: Queryable = getSql(),
): Promise<void> {
  return open
    ? openListeningWindow(lineGroupId, lineUserId, sql)
    : closeListeningWindow(lineGroupId, lineUserId, sql);
}

export async function isListening(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`
    SELECT 1 AS one
    FROM conversation_sessions
    WHERE line_group_id = ${lineGroupId}
      AND line_user_id = ${lineUserId}
      AND listening_until > now()
  `;
  return rows.length > 0;
}

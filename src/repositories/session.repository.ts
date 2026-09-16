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

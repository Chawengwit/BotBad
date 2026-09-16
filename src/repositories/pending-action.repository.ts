import { getSql, type Queryable } from "@/lib/db";

export type PendingActionType = "create_game" | "edit_game" | "cancel_game" | "close_game";

/** payload เก็บลง jsonb จึงรับได้เฉพาะค่าที่แปลงเป็น JSON ได้ */
export type PendingPayload = Record<string, string | number | boolean | null>;

export type PendingActionRow = {
  id: string;
  line_group_id: string;
  requested_by: string;
  game_id: string | null;
  action_type: PendingActionType;
  payload: PendingPayload;
};

/** ปุ่มยืนยันมีอายุ 10 นาที (spec §20) */
export const PENDING_TTL = "10 minutes";

export async function createPendingAction(
  input: {
    lineGroupId: string;
    requestedBy: string;
    actionType: PendingActionType;
    gameId?: string | null;
    payload?: PendingPayload;
  },
  sql: Queryable = getSql(),
): Promise<PendingActionRow> {
  const rows = await sql<PendingActionRow[]>`
    INSERT INTO pending_actions (line_group_id, requested_by, game_id, action_type, payload, expires_at)
    VALUES (
      ${input.lineGroupId},
      ${input.requestedBy},
      ${input.gameId ?? null},
      ${input.actionType},
      ${sql.json(input.payload ?? {})},
      now() + ${PENDING_TTL}::interval
    )
    RETURNING id, line_group_id, requested_by, game_id, action_type, payload
  `;

  const created = rows[0];
  if (!created) throw new Error("createPendingAction returned no row");
  return created;
}

/** คืนเฉพาะรายการที่ยังไม่ถูกใช้และยังไม่หมดอายุ */
export async function findUsablePendingAction(
  id: string,
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<PendingActionRow | null> {
  const rows = await sql<PendingActionRow[]>`
    SELECT id, line_group_id, requested_by, game_id, action_type, payload
    FROM pending_actions
    WHERE id = ${id}
      AND line_group_id = ${lineGroupId}
      AND used_at IS NULL
      AND expires_at > now()
  `;
  return rows[0] ?? null;
}

/**
 * หารายการที่กำลังรอให้ผู้ใช้พิมพ์ตอบ (ชื่อคอร์ท / ลิงก์แผนที่)
 * จับคู่จาก line_user_id ตรง ๆ จะได้ไม่ต้องเรียก LINE API ก่อนรู้ว่าต้องสนใจข้อความนี้ไหม
 */
export async function findAwaitingPendingAction(
  lineGroupId: string,
  lineUserId: string,
  sql: Queryable = getSql(),
): Promise<PendingActionRow | null> {
  const rows = await sql<PendingActionRow[]>`
    SELECT pa.id, pa.line_group_id, pa.requested_by, pa.game_id, pa.action_type, pa.payload
    FROM pending_actions pa
    JOIN users u ON u.id = pa.requested_by
    WHERE pa.line_group_id = ${lineGroupId}
      AND u.line_user_id = ${lineUserId}
      AND pa.used_at IS NULL
      AND pa.expires_at > now()
      AND pa.payload ->> 'awaiting' IS NOT NULL
    ORDER BY pa.created_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** อัปเดตข้อมูลที่ผู้ใช้เลือกมาทีละขั้นใน wizard */
export async function updatePendingPayload(
  id: string,
  payload: PendingPayload,
  sql: Queryable = getSql(),
): Promise<PendingActionRow | null> {
  const rows = await sql<PendingActionRow[]>`
    UPDATE pending_actions
    SET payload = ${sql.json(payload)}, updated_at = now()
    WHERE id = ${id} AND used_at IS NULL AND expires_at > now()
    RETURNING id, line_group_id, requested_by, game_id, action_type, payload
  `;
  return rows[0] ?? null;
}

/**
 * ทำเครื่องหมายว่าใช้แล้ว ใช้ได้ครั้งเดียว
 * ต้องเรียกใน transaction เดียวกับงานจริง ถ้างานพังจะได้ rollback กลับมาใช้ใหม่ได้
 */
export async function consumePendingAction(
  id: string,
  lineGroupId: string,
  sql: Queryable,
): Promise<PendingActionRow | null> {
  const rows = await sql<PendingActionRow[]>`
    UPDATE pending_actions
    SET used_at = now(), updated_at = now()
    WHERE id = ${id}
      AND line_group_id = ${lineGroupId}
      AND used_at IS NULL
      AND expires_at > now()
    RETURNING id, line_group_id, requested_by, game_id, action_type, payload
  `;
  return rows[0] ?? null;
}

/** ปิดรายการที่ค้างอยู่ เช่น ผู้ใช้กดยกเลิกเอง */
export async function expirePendingAction(
  id: string,
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    UPDATE pending_actions
    SET used_at = now(), updated_at = now()
    WHERE id = ${id} AND line_group_id = ${lineGroupId} AND used_at IS NULL
  `;
}

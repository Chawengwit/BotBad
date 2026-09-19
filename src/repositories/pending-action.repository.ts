import { getSql, type Queryable } from "@/lib/db";

export type PendingActionType =
  | "create_game"
  | "edit_game"
  | "cancel_game"
  | "close_game"
  | "create_bill"
  | "cancel_bill"
  | "edit_bill"
  | "leave_players"
  // การ์ด "รอบไหน?" ตอนกลุ่มเปิดหลายรอบ (PRP multi-open-rounds §4.3)
  | "choose_game";

/** payload เก็บลง jsonb จึงรับได้เฉพาะค่าที่แปลงเป็น JSON ได้ */
export type PendingPayloadValue =
  | string
  | number
  | boolean
  | null
  | PendingPayloadValue[]
  | { [key: string]: PendingPayloadValue };

export type PendingPayload = Record<string, PendingPayloadValue>;

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

/**
 * ลบรายการที่หมดอายุหรือใช้ไปแล้วของกลุ่มนี้
 * ทำตอนสร้างรายการใหม่ จะได้ไม่ต้องมี cron แยก (spec §27 ไม่อยากเพิ่ม infrastructure)
 */
export async function deleteFinishedPendingActions(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    DELETE FROM pending_actions
    WHERE line_group_id = ${lineGroupId}
      AND (expires_at < now() OR used_at IS NOT NULL)
  `;
}

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
  await deleteFinishedPendingActions(input.lineGroupId, sql);

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

/**
 * อัปเดตเฉพาะช่องที่เปลี่ยน โดย merge เข้ากับของเดิมในฐานข้อมูล
 * ถ้าเขียนทับทั้งก้อน การกดปุ่มสองครั้งเร็ว ๆ จะทำให้ค่าที่กดก่อนหายไป
 */
export async function updatePendingPayload(
  id: string,
  patch: PendingPayload,
  sql: Queryable = getSql(),
): Promise<PendingActionRow | null> {
  const rows = await sql<PendingActionRow[]>`
    UPDATE pending_actions
    SET payload = payload || ${sql.json(patch)}::jsonb, updated_at = now()
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

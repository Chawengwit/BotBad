import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { GET } from "../../app/api/health/route";
import { createPendingAction, updatePendingPayload } from "@/repositories/pending-action.repository";
import { saveSessionMessages } from "@/repositories/session.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { UserRow } from "@/repositories/types";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

const GROUP_ID = "C-test-cleanup";

describe.skipIf(!canRunDbTests())("เก็บกวาดข้อมูลหมดอายุ (ฐานข้อมูลจริง)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
      lineUserIds.length = 0;
    }
  }

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  // Supabase free tier มีเพดาน connection และ pool ที่ไม่ได้ปิดจะค้างไว้จนจบ process
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(async () => {
    await cleanup();
  });

  afterEach(cleanup);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(): Promise<UserRow> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return upsertUser(lineUserId, "เชวง", sql);
  }

  it("สร้างรายการใหม่แล้วลบของหมดอายุและของที่ใช้ไปแล้วทิ้ง", async () => {
    const user = await newUser();

    const expired = await createPendingAction(
      { lineGroupId: GROUP_ID, requestedBy: user.id, actionType: "create_game" },
      sql,
    );
    const used = await createPendingAction(
      { lineGroupId: GROUP_ID, requestedBy: user.id, actionType: "cancel_game" },
      sql,
    );
    await sql`UPDATE pending_actions SET expires_at = now() - interval '1 minute' WHERE id = ${expired.id}`;
    await sql`UPDATE pending_actions SET used_at = now() WHERE id = ${used.id}`;

    const fresh = await createPendingAction(
      { lineGroupId: GROUP_ID, requestedBy: user.id, actionType: "close_game" },
      sql,
    );

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM pending_actions WHERE line_group_id = ${GROUP_ID}
    `;
    expect(rows.map((row) => row.id)).toEqual([fresh.id]);
  });

  it("ไม่ไปลบรายการที่ยังใช้ได้ของกลุ่มอื่น", async () => {
    const user = await newUser();
    const otherGroup = `${GROUP_ID}-other`;

    const keep = await createPendingAction(
      { lineGroupId: otherGroup, requestedBy: user.id, actionType: "create_game" },
      sql,
    );
    await createPendingAction(
      { lineGroupId: GROUP_ID, requestedBy: user.id, actionType: "create_game" },
      sql,
    );

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM pending_actions WHERE line_group_id = ${otherGroup}
    `;
    expect(rows.map((row) => row.id)).toEqual([keep.id]);
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${otherGroup}`;
  });

  it("อัปเดต payload แบบ merge กดสองปุ่มเร็ว ๆ แล้วค่าไม่หายไป", async () => {
    const user = await newUser();
    const pending = await createPendingAction(
      { lineGroupId: GROUP_ID, requestedBy: user.id, actionType: "create_game" },
      sql,
    );

    // จำลองสองคำสั่งที่มาพร้อมกัน แต่ละอันส่งมาเฉพาะช่องของตัวเอง
    await Promise.all([
      updatePendingPayload(pending.id, { court_count: 2 }, sql),
      updatePendingPayload(pending.id, { play_date: "2030-01-15" }, sql),
    ]);

    const rows = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM pending_actions WHERE id = ${pending.id}
    `;
    expect(rows[0]?.payload).toMatchObject({ court_count: 2, play_date: "2030-01-15" });
  });

  it("บันทึก session แล้วล้าง session ที่หมดอายุ", async () => {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);

    await saveSessionMessages(GROUP_ID, lineUserId, [{ role: "user", text: "สวัสดี" }], sql);
    await sql`UPDATE conversation_sessions SET expires_at = now() - interval '1 minute' WHERE line_group_id = ${GROUP_ID}`;

    const otherUser = testLineUserId();
    lineUserIds.push(otherUser);
    await saveSessionMessages(GROUP_ID, otherUser, [{ role: "user", text: "ใหม่" }], sql);

    const rows = await sql<{ line_user_id: string }[]>`
      SELECT line_user_id FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}
    `;
    expect(rows.map((row) => row.line_user_id)).toEqual([otherUser]);
  });

  it("health endpoint ตอบ ok เมื่อฐานข้อมูลใช้งานได้", async () => {
    const res = await GET(new Request("http://localhost/api/health"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

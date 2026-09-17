import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { insertGame } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { loadSessionMessages, saveSessionMessages } from "@/repositories/session.repository";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, messageTexts } from "../helpers";

const GROUP_ID = "C-test-edit-cancel";
const ACCESS_TOKEN = "test-access-token";

type Collected = { messages: LineMessage[] };

function contextFor(collected: Collected[], displayName = "เชวง"): EventContext {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ displayName }), { status: 200 })),
  );
  return {
    accessToken: ACCESS_TOKEN,
    reply: async (_replyToken, messages) => {
      collected.push({ messages });
    },
  };
}

function textEvent(text: string, lineUserId: string) {
  return {
    type: "message",
    replyToken: `rt-${Math.random()}`,
    source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
    message: { type: "text", id: "1", text },
  };
}

function postbackEvent(data: string, lineUserId: string, params: Record<string, string> = {}) {
  return {
    type: "postback",
    replyToken: `rt-${Math.random()}`,
    source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
    postback: { data, ...(Object.keys(params).length > 0 ? { params } : {}) },
  };
}

/** หา data ของปุ่มชื่อนี้จากข้อความล่าสุด ไม่เจอถือว่าเทสผิดพลาด */
function actionData(collected: Collected[], label: string): string {
  const data = buttonData(collected.at(-1)?.messages ?? [], label);
  if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label}`);
  return data;
}

describe.skipIf(!canRunDbTests())("แก้ไข ยกเลิก ปิดรอบ (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
  }

  beforeEach(async () => {
    sql = createTestSql();
    await cleanup();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name: string): Promise<{ lineUserId: string; user: UserRow }> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  async function openGame(createdBy: string, courtCount = 2): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-15",
        startTime: "19:00",
        durationMinutes: 120,
        courtCount,
        maxPlayers: courtCount * 8,
        courtName: "คอร์ททดสอบ",
      },
      sql,
    );
  }

  it("ผู้สร้างแก้จำนวนคอร์ทได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 1);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    expect(messageTexts(collected[0]!.messages)).toContain("แก้ไขอะไร");

    await handleEvent(postbackEvent(actionData(collected, "🏟️ จำนวนคอร์ท"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "2 คอร์ท"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("1 → 2 คอร์ท");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("แก้ไขรอบเรียบร้อย");

    const rows = await sql`SELECT court_count, max_players FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_count: 2, max_players: 16 });
  });

  it("แก้เวลาแล้วรอบอัปเดตตาม", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "⏰ เวลา"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "20:00"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("19:00 → 20:00");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);

    const rows = await sql`
      SELECT to_char(start_time, 'HH24:MI') AS start_time FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(rows[0]).toMatchObject({ start_time: "20:00" });
  });

  it("ลดคอร์ทจนที่นั่งไม่พอไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 2); // รับ 16 คน

    for (let index = 0; index < 9; index += 1) {
      const player = await newUser(`ผู้เล่น ${index + 1}`);
      await joinGame(GROUP_ID, player.user.id, sql);
    }

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "🏟️ จำนวนคอร์ท"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "1 คอร์ท"), owner.lineUserId), context);

    const reply = messageTexts(collected.at(-1)!.messages);
    expect(reply).toContain("ไม่สามารถลดเหลือ 1 คอร์ทได้");
    expect(reply).toContain("มีผู้เล่น 9 คน");

    const rows = await sql`SELECT court_count FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_count: 2 });
  });

  it("ผู้สร้างแก้จำนวนคนที่รับได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 2); // ค่าปกติ 16 คน

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "👥 จำนวนคน"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "12 คน"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("รับ 16 → 12 คน");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);

    const rows = await sql`SELECT max_players, court_count FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ max_players: 12, court_count: 2 });
  });

  it("ลดจำนวนคนต่ำกว่าคนที่ลงชื่อไว้แล้วไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 2);

    for (let index = 0; index < 13; index += 1) {
      const player = await newUser(`ผู้เล่น ${index + 1}`);
      await joinGame(GROUP_ID, player.user.id, sql);
    }

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "👥 จำนวนคน"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "12 คน"), owner.lineUserId), context);

    const reply = messageTexts(collected.at(-1)!.messages);
    expect(reply).toContain("ลดเหลือ 12 คนไม่ได้");
    expect(reply).toContain("13 คน");

    const rows = await sql`SELECT max_players FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ max_players: 16 });
  });

  it("แก้ชื่อคอร์ทด้วยการพิมพ์ตอบ", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "🏸 ชื่อคอร์ท"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("คอร์ทไหน");

    await handleEvent(textEvent("คอร์ทใหม่เอี่ยม", owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("คอร์ทใหม่เอี่ยม");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);

    const rows = await sql`SELECT court_name FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_name: "คอร์ทใหม่เอี่ยม" });
  });

  it("เพิ่มเลขพร้อมเพย์ทีหลังได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "💸 พร้อมเพย์"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("พร้อมเพย์");

    await handleEvent(textEvent("081-234-5678", owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("081-234-5678");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);

    const rows = await sql`SELECT promptpay FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ promptpay: "0812345678" });
  });

  it("เลขพร้อมเพย์ผิดรูปแบบจะถามใหม่ ไม่บันทึก", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "💸 พร้อมเพย์"), owner.lineUserId), context);
    await handleEvent(textEvent("08123456", owner.lineUserId), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("10 หลัก");

    const rows = await sql`SELECT promptpay FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ promptpay: null });
  });

  it("แก้รอบเกินสองครั้ง บอทจะบ่นเรื่องเปลือง token", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 1);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    async function editCourtCount(count: string): Promise<void> {
      await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
      await handleEvent(postbackEvent(actionData(collected, "🏟️ จำนวนคอร์ท"), owner.lineUserId), context);
      await handleEvent(postbackEvent(actionData(collected, count), owner.lineUserId), context);
      await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);
    }

    await editCourtCount("2 คอร์ท");
    expect(messageTexts(collected.at(-1)!.messages)).not.toContain("เปลือง token");

    await editCourtCount("3 คอร์ท");
    expect(messageTexts(collected.at(-1)!.messages)).not.toContain("เปลือง token");

    await editCourtCount("4 คอร์ท");
    const nagged = messageTexts(collected.at(-1)!.messages);
    expect(nagged).toContain("แก้รอบนี้ไปแล้ว 3 ครั้ง");
    expect(nagged).toContain("เปลือง token");

    // บ่นแล้วก็ยังแก้ให้ตามปกติ
    const rows = await sql`SELECT court_count FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_count: 4 });
  });

  it("คนที่ไม่ได้เปิดรอบ แก้ไข ยกเลิก หรือปิดรอบไม่ได้", async () => {
    const owner = await newUser("เชวง");
    const other = await newUser("Bank");
    await openGame(owner.user.id);

    for (const command of ["แก้ไข", "ยกเลิก", "ปิดรอบ"]) {
      const collected: Collected[] = [];
      await handleEvent(textEvent(`บอทจ๋า ${command}`, other.lineUserId), contextFor(collected, "Bank"));
      expect(messageTexts(collected[0]!.messages)).toContain("เฉพาะคนที่เปิดรอบ");
    }

    const rows = await sql`SELECT status FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ status: "open" });
  });

  it("ยกเลิกรอบแล้วเปิดรอบใหม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า ยกเลิก", owner.lineUserId), context);
    expect(messageTexts(collected[0]!.messages)).toContain("ยืนยันการยกเลิก");

    await handleEvent(postbackEvent(actionData(collected, "❌ ยืนยันยกเลิก"), owner.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ยกเลิกรอบตีเรียบร้อย");

    const rows = await sql`SELECT status FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ status: "cancelled" });

    // เปิดรอบใหม่ได้แล้ว
    const again: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า เปิดตี", owner.lineUserId), contextFor(again));
    expect(messageTexts(again[0]!.messages)).toContain("กี่คอร์ท");
  });

  it("ปิดรอบแล้วสถานะเป็น completed", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "✅ ปิดรอบ"), owner.lineUserId), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("ปิดรอบเรียบร้อย");
    const rows = await sql`SELECT status FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ status: "completed" });
  });

  it("กดกลับแล้วรอบยังอยู่เหมือนเดิม", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า ยกเลิก", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "กลับ"), owner.lineUserId), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("รอบตียังเปิดอยู่เหมือนเดิม");
    const rows = await sql`SELECT status FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ status: "open" });
  });

  it("การ์ดยืนยันเก่าต้องไม่ไปปิดรอบใหม่ที่เพิ่งเปิด", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    // ขอปิดรอบสองครั้ง ได้การ์ดสองใบของรอบเดียวกัน
    const first: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.lineUserId), contextFor(first));
    const staleConfirm = actionData(first, "✅ ปิดรอบ");

    const second: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.lineUserId), contextFor(second));
    await handleEvent(postbackEvent(actionData(second, "✅ ปิดรอบ"), owner.lineUserId), contextFor(second));

    // เปิดรอบใหม่ แล้วเผลอกดการ์ดใบเก่าที่ยังค้างอยู่
    const newGame = await openGame(owner.user.id, 1);
    const stale: Collected[] = [];
    await handleEvent(postbackEvent(staleConfirm, owner.lineUserId), contextFor(stale));

    expect(messageTexts(stale[0]!.messages)).toContain("หมดอายุ");
    const rows = await sql<{ id: string; status: string }[]>`
      SELECT id, status FROM games WHERE id = ${newGame.id}
    `;
    expect(rows[0]).toMatchObject({ status: "open" });
  });

  it("เปลี่ยนจำนวนคอร์ทต้องไม่ทับจำนวนคนที่ตั้งเองไว้", async () => {
    const owner = await newUser("เชวง");
    const game = await openGame(owner.user.id, 2);
    await sql`UPDATE games SET max_players = 30 WHERE id = ${game.id}`;

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "🏟️ จำนวนคอร์ท"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "3 คอร์ท"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);

    const rows = await sql`SELECT court_count, max_players FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_count: 3, max_players: 30 });
  });

  it("ถ้าใช้ค่าปกติอยู่ เปลี่ยนคอร์ทแล้วจำนวนคนขยับตาม และการ์ดบอกให้เห็น", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id, 2); // 16 คน = ค่าปกติ

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "🏟️ จำนวนคอร์ท"), owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "3 คอร์ท"), owner.lineUserId), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("รับ 16 → 24 คน");

    await handleEvent(postbackEvent(actionData(collected, "✅ ยืนยัน"), owner.lineUserId), context);
    const rows = await sql`SELECT court_count, max_players FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ court_count: 3, max_players: 24 });
  });

  it("กดยืนยันสำเร็จแล้วต้องล้างบทสนทนาที่คุยค้างไว้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);
    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.lineUserId), context);

    // จำลองว่าระหว่างนั้นมีบทสนทนากับ LLM ค้างอยู่ (คำสั่งตรงตัวล้าง session ไปตั้งแต่บรรทัดบน)
    await saveSessionMessages(GROUP_ID, owner.lineUserId, [{ role: "user", text: "ปิดรอบให้หน่อย" }], sql);
    expect(await loadSessionMessages(GROUP_ID, owner.lineUserId, sql)).toHaveLength(1);

    await handleEvent(postbackEvent(actionData(collected, "✅ ปิดรอบ"), owner.lineUserId), context);

    expect(await loadSessionMessages(GROUP_ID, owner.lineUserId, sql)).toEqual([]);
  });

  it("ไม่มีรอบเปิดอยู่ จะแก้ไขหรือปิดรอบไม่ได้", async () => {
    const owner = await newUser("เชวง");

    const collected: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.lineUserId), contextFor(collected));

    expect(messageTexts(collected[0]!.messages)).toContain("ไม่มีรอบตีที่เปิดอยู่");
  });

  it("แก้วันที่เป็นวันที่ผ่านมาแล้วไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected);

    await handleEvent(textEvent("บอทจ๋า แก้ไข", owner.lineUserId), context);
    await handleEvent(postbackEvent(actionData(collected, "📅 วันที่"), owner.lineUserId), context);
    await handleEvent(
      postbackEvent(actionData(collected, "เลือกวัน"), owner.lineUserId, { date: "2020-01-01" }),
      context,
    );

    expect(messageTexts(collected.at(-1)!.messages)).toContain("ผ่านไปแล้ว");
    const rows = await sql`
      SELECT to_char(play_date, 'YYYY-MM-DD') AS play_date FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(rows[0]).toMatchObject({ play_date: "2030-01-15" });
  });
});

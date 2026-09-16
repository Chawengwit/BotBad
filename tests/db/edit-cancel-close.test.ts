import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { insertGame } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

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

/** หา data ของปุ่ม ไม่ว่าจะเป็นปุ่มใน template หรือ quick reply */
function actionData(collected: Collected[], label: string): string {
  for (const message of collected.at(-1)?.messages ?? []) {
    if (message.type === "template") {
      const action = message.template.actions.find((item) => item.label === label);
      if (action) return action.data;
    } else if (message.quickReply) {
      const item = message.quickReply.items.find((entry) => entry.action.label === label);
      if (item) return item.action.data;
    }
  }
  throw new Error(`ไม่พบปุ่ม ${label}`);
}

function messageTexts(messages: LineMessage[]): string {
  return messages
    .map((message) => (message.type === "text" ? message.text : message.template.text))
    .join("\n");
}

describe.skipIf(!canRunDbTests())("แก้ไข ยกเลิก ปิดรอบ (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
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

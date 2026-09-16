import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, createSql, type Sql } from "@/lib/db";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { insertGame } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, TEST_SCHEMA, testLineUserId } from "./helpers";

const GROUP_ID = "C-test-join-leave";
const ACCESS_TOKEN = "test-access-token";

type Collected = { messages: LineMessage[] };

function contextFor(collected: Collected[], displayName: string): EventContext {
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

function postbackEvent(data: string, lineUserId: string) {
  return {
    type: "postback",
    replyToken: `rt-${Math.random()}`,
    source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
    postback: { data },
  };
}

function messageTexts(messages: LineMessage[]): string {
  return messages
    .map((message) => (message.type === "text" ? message.text : message.template.text))
    .join("\n");
}

describe.skipIf(!canRunDbTests())("ลงชื่อและถอนชื่อ (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
  }

  beforeEach(async () => {
    sql = createTestSql();
    // เผื่อรอบก่อนหน้าจบไม่สวย เช่น เทสล้มกลางคัน
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

  async function openGame(createdBy: string, courtCount = 1): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-15",
        startTime: "19:00",
        durationMinutes: 120,
        courtCount,
      },
      sql,
    );
  }

  it("ลงชื่อด้วยคำสั่งแล้วนับจำนวนถูก", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ลงชื่อ", owner.lineUserId), contextFor(collected, "เชวง"));

    expect(messageTexts(collected[0]!.messages)).toContain("เชวง ลงชื่อแล้ว");
    expect(messageTexts(collected[0]!.messages)).toContain("1/8 คน");
  });

  it("ลงชื่อซ้ำไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");
    await handleEvent(postbackEvent("action=join", owner.lineUserId), context);
    await handleEvent(postbackEvent("action=join", owner.lineUserId), context);

    expect(messageTexts(collected[1]!.messages)).toContain("ลงชื่อรอบนี้ไปแล้ว");
    const rows = await sql`SELECT id FROM game_players WHERE user_id = ${owner.user.id}`;
    expect(rows).toHaveLength(1);
  });

  it("ถอนชื่อแล้วลงใหม่ได้ และนับจำนวนถูกทุกครั้ง", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");
    await handleEvent(postbackEvent("action=join", owner.lineUserId), context);
    await handleEvent(postbackEvent("action=leave", owner.lineUserId), context);
    expect(messageTexts(collected[1]!.messages)).toContain("ถอนชื่อแล้ว");
    expect(messageTexts(collected[1]!.messages)).toContain("0/8 คน");

    await handleEvent(postbackEvent("action=join", owner.lineUserId), context);
    expect(messageTexts(collected[2]!.messages)).toContain("1/8 คน");
  });

  it("ถอนชื่อทั้งที่ยังไม่ได้ลง จะบอกให้รู้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);

    const collected: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ถอนชื่อ", owner.lineUserId), contextFor(collected, "เชวง"));

    expect(messageTexts(collected[0]!.messages)).toContain("ยังไม่ได้ลงชื่อ");
  });

  it("ไม่มีรอบเปิดอยู่ ลงชื่อไม่ได้", async () => {
    const owner = await newUser("เชวง");

    const collected: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ลงชื่อ", owner.lineUserId), contextFor(collected, "เชวง"));

    expect(messageTexts(collected[0]!.messages)).toContain("ไม่มีรอบตีที่เปิดอยู่");
  });

  it("แสดงรายชื่อตามลำดับที่ลงชื่อ", async () => {
    const owner = await newUser("เชวง");
    const second = await newUser("Bank");
    await openGame(owner.user.id);

    await joinGame(GROUP_ID, owner.user.id, sql);
    await joinGame(GROUP_ID, second.user.id, sql);

    const collected: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า ใครตีบ้าง", owner.lineUserId), contextFor(collected, "เชวง"));

    const body = messageTexts(collected[0]!.messages);
    expect(body).toContain("2/8 คน");
    expect(body).toContain("1. เชวง");
    expect(body).toContain("2. Bank");
  });

  it("รอบเต็มแล้วคนต่อไปลงไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id); // 1 คอร์ท = 8 คน

    for (let index = 0; index < 8; index += 1) {
      const player = await newUser(`ผู้เล่น ${index + 1}`);
      await joinGame(GROUP_ID, player.user.id, sql);
    }

    const extra = await newUser("คนที่เก้า");
    const collected: Collected[] = [];
    await handleEvent(postbackEvent("action=join", extra.lineUserId), contextFor(collected, "คนที่เก้า"));

    expect(messageTexts(collected[0]!.messages)).toContain("รอบนี้เต็มแล้ว");
    expect(messageTexts(collected[0]!.messages)).toContain("8/8 คน");
  });

  it("กดลงชื่อพร้อมกันตอนใกล้เต็ม ก็ไม่เกินจำนวนคอร์ท", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id); // รับได้ 8 คน

    const players = [];
    for (let index = 0; index < 12; index += 1) {
      players.push(await newUser(`ผู้เล่น ${index + 1}`));
    }

    // connection เดียวจะทำให้กลายเป็นคิว ต้องใช้หลาย connection ถึงจะแย่งกันจริง
    const concurrent = createSql(process.env.DATABASE_URL!, TEST_SCHEMA, { max: 6 });
    try {
      const results = await Promise.allSettled(
        players.map((player) => joinGame(GROUP_ID, player.user.id, concurrent)),
      );

      const joined = results.filter((result) => result.status === "fulfilled").length;
      const rejected = results.filter(
        (result) => result.status === "rejected" && result.reason?.code === "GAME_FULL",
      ).length;

      expect(joined).toBe(8);
      expect(rejected).toBe(4);
    } finally {
      await concurrent.end({ timeout: 5 });
    }

    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE g.line_group_id = ${GROUP_ID} AND gp.status = 'joined'
    `;
    expect(rows[0]?.count).toBe(8);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

const GROUP_ID = "C-test-create-game";
const ACCESS_TOKEN = "test-access-token";

type Collected = { replyToken: string; messages: LineMessage[] };

function makeContext(collected: Collected[]): EventContext {
  return {
    accessToken: ACCESS_TOKEN,
    reply: async (replyToken, messages) => {
      collected.push({ replyToken, messages });
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

/** ดึง data ของปุ่มแรกที่ตรงกับ step ที่ต้องการ */
function actionData(messages: LineMessage[], label?: string): string {
  const template = messages.find((message) => message.type === "template");
  if (!template || template.type !== "template") throw new Error("ไม่พบปุ่มในข้อความตอบกลับ");

  const action = label
    ? template.template.actions.find((item) => item.label === label)
    : template.template.actions[0];
  if (!action) throw new Error(`ไม่พบปุ่ม ${label ?? "(ตัวแรก)"}`);
  return action.data;
}

function messageTexts(messages: LineMessage[]): string {
  return messages
    .map((message) => (message.type === "text" ? message.text : message.template.text))
    .join("\n");
}

describe.skipIf(!canRunDbTests())("เปิดรอบตี (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  beforeEach(() => {
    sql = createTestSql();
    // ensureUser จะไปถาม LINE ว่าชื่ออะไร ตอบแทนให้ไม่ต้องยิงเน็ตจริง
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "เชวง" }), { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  function newUser(): string {
    const id = testLineUserId();
    lineUserIds.push(id);
    return id;
  }

  /** เดินครบทุกขั้นของ wizard จนถึงการ์ดยืนยัน คืน pending_id */
  async function runWizard(userId: string, collected: Collected[]): Promise<string> {
    const context = makeContext(collected);

    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), context);
    const courtData = actionData(collected.at(-1)!.messages, "2 คอร์ท");

    await handleEvent(postbackEvent(courtData, userId), context);
    const dateData = actionData(collected.at(-1)!.messages, "พรุ่งนี้");

    await handleEvent(postbackEvent(dateData, userId), context);
    const timeData = actionData(collected.at(-1)!.messages, "19:00");

    await handleEvent(postbackEvent(timeData, userId), context);
    const durationData = actionData(collected.at(-1)!.messages, "2 ชั่วโมง");

    await handleEvent(postbackEvent(durationData, userId), context);
    const confirmData = actionData(collected.at(-1)!.messages, "✅ เปิดตี");

    return new URLSearchParams(confirmData).get("pending_id")!;
  }

  it("ถามทีละขั้นแล้วเปิดรอบได้จริง", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const pendingId = await runWizard(userId, collected);

    expect(messageTexts(collected[0]!.messages)).toContain("กี่คอร์ท");
    expect(messageTexts(collected[1]!.messages)).toContain("วันไหน");
    expect(messageTexts(collected[2]!.messages)).toContain("กี่โมง");
    expect(messageTexts(collected[3]!.messages)).toContain("เล่นกี่ชั่วโมง");
    expect(messageTexts(collected[4]!.messages)).toContain("ยืนยันไหม");

    await handleEvent(
      postbackEvent(`action=confirm&pending_id=${pendingId}`, userId),
      makeContext(collected),
    );

    expect(messageTexts(collected.at(-1)!.messages)).toContain("0/16 คน");

    const games = await sql`
      SELECT court_count, max_players, status, duration_minutes,
             to_char(play_date, 'YYYY-MM-DD') AS play_date,
             to_char(start_time, 'HH24:MI') AS start_time
      FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      court_count: 2,
      max_players: 16,
      status: "open",
      start_time: "19:00",
      duration_minutes: 120,
    });
  });

  it("กลุ่มเดียวเปิดรอบซ้อนไม่ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const pendingId = await runWizard(userId, collected);
    await handleEvent(postbackEvent(`action=confirm&pending_id=${pendingId}`, userId), makeContext(collected));

    const second: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), makeContext(second));

    expect(messageTexts(second[0]!.messages)).toContain("มีรอบที่เปิดอยู่แล้ว");
    const games = await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(games).toHaveLength(1);
  });

  it("คนอื่นกดปุ่มของคนที่สั่งไม่ได้", async () => {
    const owner = newUser();
    const stranger = newUser();
    const collected: Collected[] = [];

    await handleEvent(textEvent("บอทจ๋า เปิดตี", owner), makeContext(collected));
    const courtData = actionData(collected[0]!.messages, "1 คอร์ท");

    const strangerReplies: Collected[] = [];
    await handleEvent(postbackEvent(courtData, stranger), makeContext(strangerReplies));

    expect(messageTexts(strangerReplies[0]!.messages)).toContain("เฉพาะคนที่สั่ง");
  });

  it("ปุ่มยืนยันใช้ได้ครั้งเดียว", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const pendingId = await runWizard(userId, collected);

    await handleEvent(postbackEvent(`action=confirm&pending_id=${pendingId}`, userId), makeContext(collected));
    const again: Collected[] = [];
    await handleEvent(postbackEvent(`action=confirm&pending_id=${pendingId}`, userId), makeContext(again));

    expect(messageTexts(again[0]!.messages)).toContain("หมดอายุหรือถูกใช้ไปแล้ว");
    const games = await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(games).toHaveLength(1);
  });

  it("กดยกเลิกแล้วไม่เปิดรอบ และปุ่มเดิมใช้ต่อไม่ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const pendingId = await runWizard(userId, collected);

    const rejected: Collected[] = [];
    await handleEvent(postbackEvent(`action=reject&pending_id=${pendingId}`, userId), makeContext(rejected));
    expect(messageTexts(rejected[0]!.messages)).toContain("ยกเลิกแล้ว");

    const afterReject: Collected[] = [];
    await handleEvent(postbackEvent(`action=confirm&pending_id=${pendingId}`, userId), makeContext(afterReject));
    expect(messageTexts(afterReject[0]!.messages)).toContain("หมดอายุ");

    const games = await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(games).toHaveLength(0);
  });

  it("ปุ่มที่หมดอายุแล้วใช้ไม่ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const pendingId = await runWizard(userId, collected);

    await sql`UPDATE pending_actions SET expires_at = now() - interval '1 minute' WHERE id = ${pendingId}`;

    const expired: Collected[] = [];
    await handleEvent(postbackEvent(`action=confirm&pending_id=${pendingId}`, userId), makeContext(expired));

    expect(messageTexts(expired[0]!.messages)).toContain("หมดอายุ");
    const games = await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(games).toHaveLength(0);
  });

  it("เลือกวันจากปฏิทินและเวลาที่กำหนดเองได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 คอร์ท"), userId), context);

    const pickerData = actionData(collected.at(-1)!.messages, "เลือกวัน");
    await handleEvent(postbackEvent(pickerData, userId, { date: "2030-01-15" }), context);

    const timePicker = actionData(collected.at(-1)!.messages, "กำหนดเวลาเอง");
    await handleEvent(postbackEvent(timePicker, userId, { time: "20:30" }), context);

    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 ชั่วโมง"), userId), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);

    expect(confirmText).toContain("อังคาร 15 ม.ค.");
    expect(confirmText).toContain("20:30 - 21:30");
  });

  it("ปฏิเสธรอบที่วันเวลาผ่านไปแล้ว", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 คอร์ท"), userId), context);

    const pickerData = actionData(collected.at(-1)!.messages, "เลือกวัน");
    await handleEvent(postbackEvent(pickerData, userId, { date: "2020-01-01" }), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "19:00"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 ชั่วโมง"), userId), context);

    const confirmData = actionData(collected.at(-1)!.messages, "✅ เปิดตี");
    const result: Collected[] = [];
    await handleEvent(postbackEvent(confirmData, userId), makeContext(result));

    expect(messageTexts(result[0]!.messages)).toContain("ผ่านไปแล้ว");
    const games = await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(games).toHaveLength(0);
  });
});

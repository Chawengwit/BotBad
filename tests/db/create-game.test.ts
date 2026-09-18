import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { DEFAULT_START_TIME } from "@/line/messages";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, messageTexts } from "../helpers";

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

function locationEvent(lineUserId: string, latitude: number, longitude: number) {
  return {
    type: "message",
    replyToken: `rt-${Math.random()}`,
    source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
    message: { type: "location", id: "1", title: "คอร์ท", address: "กรุงเทพ", latitude, longitude },
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

/** หา data ของปุ่มชื่อนี้ ไม่เจอถือว่าเทสผิดพลาด ไม่ใช่ปล่อยผ่าน */
function actionData(messages: LineMessage[], label: string): string {
  const data = buttonData(messages, label);
  if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label}`);
  return data;
}

describe.skipIf(!canRunDbTests())("เปิดรอบตี (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
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
    // ensureUser จะไปถาม LINE ว่าชื่ออะไร ตอบแทนให้ไม่ต้องยิงเน็ตจริง
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "เชวง" }), { status: 200 })),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
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

  /**
   * เดินจนถึงคำถามชื่อคอร์ท: คอร์ท → เมื่อไหร่ → กี่ชั่วโมง (spec §9.1)
   * ทุกเทสเริ่มจากกลุ่มที่ไม่มีรอบเก่า บอทจึงถามชื่อคอร์ท ไม่ใช่เสนอ "ที่เดิม"
   */
  async function runUntilCourtName(userId: string, collected: Collected[]): Promise<void> {
    const context = makeContext(collected);
    const press = (label: string) =>
      handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, label), userId), context);

    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), context);
    await press("2 คอร์ท");
    await press(`พรุ่งนี้ ${DEFAULT_START_TIME}`);
    await press("2 ชั่วโมง");
  }

  it("ถามครบทุกขั้นแล้วเปิดรอบได้ พร้อมชื่อคอร์ทและแผนที่", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);

    expect(messageTexts(collected[0]!.messages)).toContain("กี่คอร์ท");
    expect(messageTexts(collected[1]!.messages)).toContain("ตีเมื่อไหร่");
    expect(messageTexts(collected[2]!.messages)).toContain("เล่นกี่ชั่วโมง");
    expect(messageTexts(collected[3]!.messages)).toContain("คอร์ทไหน");

    // ตอบชื่อคอร์ทด้วยข้อความธรรมดา ไม่ต้องมี wake word
    await handleEvent(textEvent("ABC Badminton", userId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ลิงก์แผนที่");

    await handleEvent(textEvent("อยู่ตรงนี้ https://maps.app.goo.gl/abc123", userId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("พร้อมเพย์");

    // พิมพ์มาแบบมีขีดคั่น ระบบต้องเก็บเป็นตัวเลขล้วนแต่แสดงผลให้อ่านง่าย
    await handleEvent(textEvent("081-234-5678", userId), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);
    expect(confirmText).toContain("ABC Badminton");
    expect(confirmText).toContain("รับ 16 คน");
    expect(confirmText).toContain("พร้อมเพย์ 081-234-5678");

    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "เปิดตี"), userId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("0/16 คน");

    const games = await sql`
      SELECT court_count, max_players, court_name, location_url, promptpay, status
      FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(games[0]).toMatchObject({
      court_count: 2,
      max_players: 16,
      court_name: "ABC Badminton",
      location_url: "https://maps.app.goo.gl/abc123",
      promptpay: "0812345678",
      status: "open",
    });
  });

  // wizard ไม่ถามจำนวนคนแล้ว คิดจากคอร์ทให้เลย ใครอยากเปลี่ยนสั่ง "แก้ไข" ทีหลัง (spec §9.1)
  it("จำนวนคนมาจากจำนวนคอร์ทเองโดยไม่ต้องถาม", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    expect(messageTexts(collected.map((entry) => entry.messages).flat())).not.toContain("รับกี่คน");

    await handleEvent(textEvent("คอร์ทลุงหมี", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "เปิดตี"), userId), context);

    const games = await sql`
      SELECT court_count, max_players, court_name, location_url, promptpay
      FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(games[0]).toMatchObject({
      court_count: 2,
      max_players: 16,
      court_name: "คอร์ทลุงหมี",
      location_url: null,
      promptpay: null,
    });
  });

  it("แชร์ตำแหน่งจาก LINE แทนการวางลิงก์ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    await handleEvent(textEvent("คอร์ทริมน้ำ", userId), context);
    await handleEvent(locationEvent(userId, 13.7563, 100.5018), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "เปิดตี"), userId), context);

    const games = await sql<{ location_url: string }[]>`
      SELECT location_url FROM games WHERE line_group_id = ${GROUP_ID}
    `;
    expect(games[0]?.location_url).toBe(
      "https://www.google.com/maps/search/?api=1&query=13.7563,100.5018",
    );
  });

  it("ชื่อคอร์ทยาวเกินไปจะถามใหม่ ไม่บันทึก", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    await handleEvent(textEvent("ก".repeat(80), userId), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("1-60 ตัวอักษร");

    const pending = await sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM pending_actions WHERE line_group_id = ${GROUP_ID}
    `;
    expect(pending[0]?.payload.court_name).toBeUndefined();
  });

  it("ข้อความของคนอื่นระหว่างรอคำตอบ ไม่ถูกนับเป็นคำตอบ", async () => {
    const owner = newUser();
    const stranger = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(owner, collected);

    const before = collected.length;
    await handleEvent(textEvent("เย็นนี้ฝนตกไหม", stranger), context);
    expect(collected).toHaveLength(before);

    await handleEvent(textEvent("คอร์ทเจ้าเก่า", owner), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ลิงก์แผนที่");
  });

  it("กลุ่มเดียวเปิดรอบซ้อนไม่ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    await handleEvent(textEvent("คอร์ทแรก", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "เปิดตี"), userId), context);

    const second: Collected[] = [];
    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), makeContext(second));

    expect(messageTexts(second[0]!.messages)).toContain("มีรอบที่เปิดอยู่แล้ว");
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(1);
  });

  it("คนอื่นกดปุ่มของคนที่สั่ง บอทเงียบ และคนสั่งยังกดต่อได้", async () => {
    const owner = newUser();
    const stranger = newUser();
    const collected: Collected[] = [];

    await handleEvent(textEvent("บอทจ๋า เปิดตี", owner), makeContext(collected));
    const courtData = actionData(collected[0]!.messages, "1 คอร์ท");

    const strangerReplies: Collected[] = [];
    await handleEvent(postbackEvent(courtData, stranger), makeContext(strangerReplies));
    expect(strangerReplies).toHaveLength(0);

    const ownerReplies: Collected[] = [];
    await handleEvent(postbackEvent(courtData, owner), makeContext(ownerReplies));
    expect(messageTexts(ownerReplies[0]!.messages)).toContain("ตีเมื่อไหร่");
  });

  it("คนอื่นกดยืนยันแทน บอทเงียบ และยังไม่เปิดรอบ", async () => {
    const owner = newUser();
    const stranger = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(owner, collected);
    await handleEvent(textEvent("คอร์ทแย่งกด", owner), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), owner), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), owner), context);
    const confirmData = actionData(collected.at(-1)!.messages, "เปิดตี");

    const strangerReplies: Collected[] = [];
    await handleEvent(postbackEvent(confirmData, stranger), makeContext(strangerReplies));

    expect(strangerReplies).toHaveLength(0);
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });


  it("ปุ่มยืนยันใช้ได้ครั้งเดียว", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    await handleEvent(textEvent("คอร์ทเดิม", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    const confirmData = actionData(collected.at(-1)!.messages, "เปิดตี");

    await handleEvent(postbackEvent(confirmData, userId), context);
    const again: Collected[] = [];
    await handleEvent(postbackEvent(confirmData, userId), makeContext(again));

    // กดซ้ำไม่ต้องตอบ แชทกลุ่มจะได้ไม่รก
    expect(again).toHaveLength(0);
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(1);
  });

  it("ปุ่มที่หมดอายุแล้วใช้ไม่ได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await runUntilCourtName(userId, collected);
    await handleEvent(textEvent("คอร์ทหมดอายุ", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    const confirmData = actionData(collected.at(-1)!.messages, "เปิดตี");

    await sql`UPDATE pending_actions SET expires_at = now() - interval '1 minute' WHERE line_group_id = ${GROUP_ID}`;

    const expired: Collected[] = [];
    await handleEvent(postbackEvent(confirmData, userId), makeContext(expired));

    expect(expired).toHaveLength(0);
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });

  it("เลือกวันจากปฏิทินและเวลาที่กำหนดเองได้", async () => {
    const userId = newUser();
    const collected: Collected[] = [];
    const context = makeContext(collected);

    await handleEvent(textEvent("บอทจ๋า เปิดตี", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 คอร์ท"), userId), context);

    // ปฏิทินเลือกได้ทั้งวันและเวลาในครั้งเดียว
    const pickerData = actionData(collected.at(-1)!.messages, "เลือกวันและเวลา");
    await handleEvent(postbackEvent(pickerData, userId, { datetime: "2030-01-15T20:30" }), context);

    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 ชั่วโมง"), userId), context);
    await handleEvent(textEvent("คอร์ทกลางคืน", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);

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

    const pickerData = actionData(collected.at(-1)!.messages, "เลือกวันและเวลา");
    await handleEvent(postbackEvent(pickerData, userId, { datetime: "2020-01-01T19:00" }), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "1 ชั่วโมง"), userId), context);
    await handleEvent(textEvent("คอร์ทย้อนอดีต", userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);
    await handleEvent(postbackEvent(actionData(collected.at(-1)!.messages, "ข้าม"), userId), context);

    const confirmData = actionData(collected.at(-1)!.messages, "เปิดตี");
    const result: Collected[] = [];
    await handleEvent(postbackEvent(confirmData, userId), makeContext(result));

    expect(messageTexts(result[0]!.messages)).toContain("ผ่านไปแล้ว");
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });
});

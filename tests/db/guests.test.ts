import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { isAppError } from "@/errors/app-errors";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { insertGame } from "@/repositories/game.repository";
import { listJoinedPlayers } from "@/repositories/player.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, LineUserRow } from "@/repositories/types";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, messageTexts } from "../helpers";

const GROUP_ID = "C-test-guests";
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

/**
 * แขกและการลงชื่อแทนกัน (PRP guests-split-bills-and-digest §4)
 * เทสชุดนี้เดินผ่าน handleEvent จริง เพราะจุดที่พังง่ายคือการแปลชื่อเป็นคน ไม่ใช่การคำนวณ
 */
describe.skipIf(!canRunDbTests())("แขกและการลงชื่อแทน (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM bills WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
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

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await cleanup();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name: string): Promise<{ lineUserId: string; user: LineUserRow }> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  async function openGame(createdBy: string, maxPlayers = 16): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-15",
        startTime: "19:00",
        durationMinutes: 120,
        courtCount: 2,
        maxPlayers,
        courtName: "คอร์ททดสอบ",
        locationUrl: null,
        promptpay: null,
      },
      sql,
    );
  }

  async function names(gameId: string): Promise<string[]> {
    return (await listJoinedPlayers(gameId, sql)).map((player) => player.display_name);
  }

  it("พาแขกสองคนมาด้วยคำสั่งเดียว", async () => {
    const hok = await newUser("ฮก");
    const game = await openGame(hok.user.id);

    const collected: Collected[] = [];
    await handleEvent(
      textEvent("บอทจ๋า ลงชื่อ กิ้ฟ วิท", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );

    const body = messageTexts(collected.at(-1)!.messages);
    expect(body).toContain("ฮก ลงชื่อให้ กิ้ฟ, วิท");
    expect(body).toContain("เพิ่มแขกใหม่");
    expect(await names(game.id)).toEqual(["กิ้ฟ", "วิท"]);

    // แขกเก็บเป็นแถวใน users ที่ไม่มี line_user_id และผูกกับกลุ่ม
    const guests = await sql<{ display_name: string; line_user_id: string | null }[]>`
      SELECT display_name, line_user_id FROM users
      WHERE line_group_id = ${GROUP_ID} ORDER BY display_name
    `;
    expect(guests).toHaveLength(2);
    expect(guests.every((guest) => guest.line_user_id === null)).toBe(true);
  });

  it("แขกชื่อเดิมมาอีกรอบ ใช้แถวเดิม ไม่งอกคนใหม่", async () => {
    const hok = await newUser("ฮก");
    const first = await openGame(hok.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "ฮก");
    await handleEvent(textEvent("บอทจ๋า ลงชื่อ กิ้ฟ", hok.lineUserId), context);

    const guestId = (
      await sql<{ id: string }[]>`
        SELECT id FROM users WHERE line_group_id = ${GROUP_ID} AND display_name = ${"กิ้ฟ"}
      `
    )[0]?.id;

    await sql`UPDATE games SET status = 'completed' WHERE id = ${first.id}`;
    const second = await openGame(hok.user.id);
    await handleEvent(textEvent("บอทจ๋า ลงชื่อ กิ้ฟ", hok.lineUserId), context);

    expect(await sql`SELECT id FROM users WHERE line_group_id = ${GROUP_ID}`).toHaveLength(1);
    expect((await listJoinedPlayers(second.id, sql))[0]?.user_id).toBe(guestId);
  });

  it("แขกนับรวมในจำนวนคนของรอบ ลงเกินไม่ได้", async () => {
    const hok = await newUser("ฮก");
    const game = await openGame(hok.user.id, 2);
    await joinGame(GROUP_ID, game.id, hok.user.id, sql);

    const collected: Collected[] = [];
    await handleEvent(
      textEvent("บอทจ๋า ลงชื่อ กิ้ฟ วิท", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );

    expect(messageTexts(collected.at(-1)!.messages)).toContain("เต็มแล้ว");
    // ทั้งคำสั่งอยู่ในทรานแซกชันเดียว คนแรกต้องไม่ค้างอยู่ในรอบ
    expect(await names(game.id)).toEqual(["ฮก"]);
  });

  it("ถอนแขกของคนอื่นไม่ได้ ของตัวเองได้", async () => {
    const hok = await newUser("ฮก");
    const other = await newUser("เชวง");
    const game = await openGame(hok.user.id);

    const collected: Collected[] = [];
    await handleEvent(
      textEvent("บอทจ๋า ลงชื่อ กิ้ฟ", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );

    await handleEvent(
      textEvent("บอทจ๋า ถอนชื่อ กิ้ฟ", other.lineUserId),
      contextFor(collected, "เชวง"),
    );
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ถอนได้เฉพาะเจ้าตัว");
    expect(await names(game.id)).toEqual(["กิ้ฟ"]);

    await handleEvent(
      textEvent("บอทจ๋า ถอนชื่อ กิ้ฟ", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ฮก ถอนชื่อให้ กิ้ฟ");
    expect(await names(game.id)).toEqual([]);
  });

  it("ลงชื่อแทนสมาชิกจริงที่เคยเล่นในกลุ่มนี้ได้ ถอนเองก็ได้", async () => {
    const hok = await newUser("ฮก");
    const bank = await newUser("Bank");
    const game = await openGame(hok.user.id);

    // Bank ต้องเคยอยู่ในรอบของกลุ่มนี้ก่อน บอทถึงจะรู้จักชื่อ (ดึงรายชื่อจาก LINE ไม่ได้)
    await joinGame(GROUP_ID, game.id, bank.user.id, sql);
    await sql`UPDATE game_players SET status = 'cancelled' WHERE game_id = ${game.id} AND user_id = ${bank.user.id}`;

    const collected: Collected[] = [];
    await handleEvent(
      textEvent("บอทจ๋า ลงชื่อ Bank", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );
    expect(await names(game.id)).toEqual(["Bank"]);

    // เจ้าตัวถอนเองได้เสมอ แม้คนอื่นเป็นคนลงให้
    await handleEvent(
      textEvent("บอทจ๋า ถอนชื่อ", bank.lineUserId),
      contextFor(collected, "Bank"),
    );
    expect(await names(game.id)).toEqual([]);
  });

  it("ถอนชื่อที่ไม่ได้อยู่ในรายชื่อ บอกว่าไม่อยู่ในรายชื่อ ไม่สร้างแขกใหม่", async () => {
    const hok = await newUser("ฮก");
    await openGame(hok.user.id);

    const collected: Collected[] = [];
    await handleEvent(
      textEvent("บอทจ๋า ถอนชื่อ สมชาย", hok.lineUserId),
      contextFor(collected, "ฮก"),
    );

    expect(messageTexts(collected.at(-1)!.messages)).toContain("สมชาย ไม่ได้อยู่ในรายชื่อรอบนี้");
    expect(await sql`SELECT id FROM users WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });

  it("คำสั่งเดิมที่ไม่มีส่วนเติมท้าย ยังทำงานเหมือนเดิม", async () => {
    const hok = await newUser("ฮก");
    const game = await openGame(hok.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "ฮก");

    await handleEvent(textEvent("บอทจ๋า ลงชื่อ", hok.lineUserId), context);
    expect(await names(game.id)).toEqual(["ฮก"]);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ฮก ลงชื่อแล้ว");

    await handleEvent(textEvent("บอทจ๋า ถอนชื่อ", hok.lineUserId), context);
    expect(await names(game.id)).toEqual([]);
  });

  it("แขกอยู่ในบิล และคนพาจ่ายแทนได้", async () => {
    const hok = await newUser("ฮก");
    const game = await openGame(hok.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "ฮก");
    await handleEvent(textEvent("บอทจ๋า ลงชื่อ ฉัน กิ้ฟ วิท", hok.lineUserId), context);
    expect(await names(game.id)).toEqual(["ฮก", "กิ้ฟ", "วิท"]);

    await handleEvent(textEvent("บอทจ๋า คิดเงิน", hok.lineUserId), context);
    await pressButton(collected, "คิดค่ารอบ", hok.lineUserId, context);
    await handleEvent(textEvent("300", hok.lineUserId), context);
    await pressButton(collected, "ไม่มี", hok.lineUserId, context);
    await pressButton(collected, "ไม่มีแล้ว", hok.lineUserId, context);
    await pressButton(collected, "ส่งบิล", hok.lineUserId, context);

    const cardText = messageTexts(collected.at(-1)!.messages);
    expect(cardText).toContain("คิดเงินแล้ว");
    expect(cardText).toContain("กิ้ฟ");

    // แขกพิมพ์เองไม่ได้ คนพาต้องกดแทน
    await handleEvent(textEvent("บอทจ๋า จ่ายแล้ว ฉัน กิ้ฟ วิท", hok.lineUserId), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("รวม กิ้ฟ, วิท");

    const shares = await sql<{ paid: boolean }[]>`
      SELECT bs.paid FROM bill_shares bs
      JOIN bills b ON b.id = bs.bill_id
      WHERE b.line_group_id = ${GROUP_ID}
    `;
    expect(shares.every((share) => share.paid)).toBe(true);
  });

  async function pressButton(
    collected: Collected[],
    label: string,
    lineUserId: string,
    context: EventContext,
  ): Promise<void> {
    const data = buttonData(collected.at(-1)!.messages, label);
    if (!data) throw new Error(`ไม่พบปุ่ม ${label}`);

    await handleEvent(
      {
        type: "postback",
        replyToken: `rt-${Math.random()}`,
        source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
        postback: { data },
      },
      context,
    );
  }

  it("บิลลอย ๆ ที่ไม่ผูกกับรอบ เก็บเฉพาะคนที่เอ่ยชื่อ", async () => {
    const hok = await newUser("ฮก");
    await openGame(hok.user.id);

    const collected: Collected[] = [];
    const context = contextFor(collected, "ฮก");

    // ไม่มี Gemini: ตั้งชื่อบิลมากับคำสั่ง แล้วตอบทีละขั้นแบบเดิม (มี Gemini จะให้พิมพ์รายการมาอิสระ)
    vi.stubEnv("GEMINI_API_KEY", "");

    await handleEvent(textEvent("บอทจ๋า คิดเงิน ค่ากินข้าว", hok.lineUserId), context);
    await pressButton(collected, "ไม่มีค่าคอร์ท", hok.lineUserId, context);
    await pressButton(collected, "ไม่มี", hok.lineUserId, context);
    await pressButton(collected, "อื่น ๆ", hok.lineUserId, context);
    await handleEvent(textEvent("ค่าข้าว 300 ฮก กิ้ฟ", hok.lineUserId), context);
    await pressButton(collected, "ไม่มีแล้ว", hok.lineUserId, context);
    // บิลลอย ๆ ไม่มีรอบให้ดึงเลขพร้อมเพย์ ถามคนสร้างบิลก่อนขึ้นการ์ดยืนยัน (PRP §5.2.1)
    expect(messageTexts(collected.at(-1)!.messages)).toContain("เลขพร้อมเพย์");
    await pressButton(collected, "ข้าม", hok.lineUserId, context);
    await pressButton(collected, "ส่งบิล", hok.lineUserId, context);

    const bills = await sql<{ game_id: string | null; title: string }[]>`
      SELECT game_id, title FROM bills WHERE line_group_id = ${GROUP_ID}
    `;
    expect(bills[0]).toMatchObject({ game_id: null, title: "ค่ากินข้าว" });

    const shares = await sql<{ display_name: string; amount_satang: number }[]>`
      SELECT u.display_name, bs.amount_satang::int AS amount_satang
      FROM bill_shares bs
      JOIN users u ON u.id = bs.user_id
      JOIN bills b ON b.id = bs.bill_id
      WHERE b.line_group_id = ${GROUP_ID}
      ORDER BY u.display_name
    `;
    expect(shares.map((share) => share.display_name).sort()).toEqual(["กิ้ฟ", "ฮก"]);
    expect(shares.every((share) => share.amount_satang === 15000)).toBe(true);
  });

  it("ลงชื่อแทนเกินจำนวนที่กำหนดต่อคำสั่ง ถูกตัดทิ้ง", async () => {
    const hok = await newUser("ฮก");
    const game = await openGame(hok.user.id, 64);

    const many = Array.from({ length: 15 }, (_, index) => `แขก${index}`).join(" ");
    const collected: Collected[] = [];
    await handleEvent(
      textEvent(`บอทจ๋า ลงชื่อ ${many}`, hok.lineUserId),
      contextFor(collected, "ฮก"),
    );

    expect(await names(game.id)).toHaveLength(10);
  });

  it("ฐานข้อมูลกันแขกชื่อซ้ำในกลุ่มเดียวกัน", async () => {
    const hok = await newUser("ฮก");
    await openGame(hok.user.id);

    await sql`INSERT INTO users (line_group_id, display_name) VALUES (${GROUP_ID}, ${"กิ้ฟ"})`;

    const failed = await sql`
      INSERT INTO users (line_group_id, display_name) VALUES (${GROUP_ID}, ${"กิ้ฟ"})
    `.catch((error: unknown) => (isAppError(error) ? "APP_ERROR" : "DB_REJECTED"));

    expect(failed).toBe("DB_REJECTED");
  });
});

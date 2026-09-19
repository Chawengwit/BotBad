import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { handleEvent } from "@/line/handle-event";
import type { LineEvent } from "@/line/webhook-schema";
import { insertGame } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, LineUserRow } from "@/repositories/types";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, messageTexts } from "../helpers";

const GROUP_ID = "C-test-leave-check";

/** Gemini ปลอม ตอบตามสคริปต์ทีละรอบ */
function fakeClient(turns: GeminiTurn[]): GeminiClient {
  let calls = 0;
  return {
    async generate() {
      const turn = turns[Math.min(calls, turns.length - 1)];
      calls += 1;
      return turn ?? { text: "", calls: [] };
    },
  };
}

const say = (text: string): GeminiTurn => ({ text, calls: [] });
const call = (name: string, args: Record<string, unknown> = {}): GeminiTurn => ({
  text: "",
  calls: [{ name, args }],
});

/** ข้อความที่ LLM แต่งเอง ใช้ดูว่ามันหลุดไปถึงแชทหรือเปล่า */
const LLM_OWN_WORDS = "ข้อความที่ LLM แต่งเอง";

let currentClient: GeminiClient = fakeClient([]);

// handle-event สร้าง client เองทุกครั้ง จึงต้องดักที่จุดสร้าง ไม่ใช่ส่งเข้าไปทางพารามิเตอร์
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  createGeminiClient: () => currentClient,
}));

/**
 * ถอนชื่อต้องเช็กจากรายชื่อรอบจริงก่อน และพิมพ์เป็นประโยคแล้วบอทต้องไม่พูดว่าทำแล้วเอง
 *
 * ตั้งต้นจากแชทจริงของกลุ่มเมื่อ 2026-09-18 11:10: รอบที่เปิดอยู่ยังไม่มีใครลงชื่อ และไม่มีใครชื่อ louis
 * แต่บอทตอบว่า "ถอนชื่อ louis ออกจากรอบให้แล้วครับ 👍" เพราะ tool ที่ไม่สำเร็จไม่ส่งข้อความอะไรออกไปเลย
 * ในแชทจึงเหลือแค่ข้อความที่ LLM แต่ง
 */
describe.skipIf(!canRunDbTests())("ถอนชื่อ เช็กรายชื่อก่อน และไม่พูดว่าทำแล้วเอง (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];
  let owner: { lineUserId: string; user: LineUserRow };
  let give: { lineUserId: string; user: LineUserRow };
  let game: GameRow;

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
    await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
  }

  async function newMember(name: string): Promise<{ lineUserId: string; user: LineUserRow }> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(async () => {
    await cleanup();
    currentClient = fakeClient([say("ได้เลยครับ")]);
    vi.stubEnv("GEMINI_API_KEY", "fake-key-value");

    owner = await newMember("Chawengwit, ฮก");
    give = await newMember("give ツ");
    // ชื่อผู้ใช้มาจาก LINE Profile API ระหว่างเทสไม่ยิงเน็ตจริง ทุกข้อความในไฟล์นี้ give เป็นคนพิมพ์
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "give ツ" }), { status: 200 })),
    );

    // เหมือนรอบที่เปิดอยู่ตอนเกิดเรื่อง: 1 คอร์ท 8 คน ยังไม่มีใครลงชื่อ
    game = await insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy: owner.user.id,
        playDate: "2030-01-18",
        startTime: "18:00",
        durationMinutes: 120,
        courtCount: 1,
        maxPlayers: 8,
        courtName: "คอร์ทสามย่าน",
      },
      sql,
    );
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function deliver(event: LineEvent): Promise<LineMessage[]> {
    const replies: LineMessage[][] = [];
    await handleEvent(event, {
      accessToken: "test-access-token",
      reply: async (_token, messages) => {
        replies.push(messages);
      },
    });
    return replies[0] ?? [];
  }

  /** give พิมพ์ข้อความเข้ากลุ่ม คืนข้อความที่บอทตอบ (ว่าง = เงียบ) */
  function send(text: string): Promise<LineMessage[]> {
    return deliver({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: give.lineUserId },
      message: { type: "text", text },
    } as LineEvent);
  }

  /** give กดปุ่มชื่อนี้บนข้อความที่ระบุ ไม่เจอปุ่มถือว่าเทสผิด */
  function press(label: string, on: LineMessage[]): Promise<LineMessage[]> {
    const data = buttonData(on, label);
    if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label}`);

    return deliver({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: give.lineUserId },
      postback: { data },
    } as LineEvent);
  }

  async function joinedNames(): Promise<string[]> {
    const rows = await sql<{ display_name: string }[]>`
      SELECT u.display_name FROM game_players gp JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = ${game.id} AND gp.status = 'joined'
      ORDER BY gp.id
    `;
    return rows.map((row) => row.display_name);
  }

  it("พิมพ์คำสั่งถอนชื่อคนที่ไม่อยู่ในรายชื่อ บอกว่าไม่อยู่ในรายชื่อรอบนี้", async () => {
    expect(messageTexts(await send("บอทจ๋า ถอนชื่อ louis"))).toBe("ℹ️ louis ไม่ได้อยู่ในรายชื่อรอบนี้");
  });

  it("แชทจริง 11:10: LLM เรียกถอน louis แล้วพูดว่าถอนให้แล้ว แชทต้องได้ผลจริงจากระบบแทน", async () => {
    currentClient = fakeClient([
      call("leave_game", { names: ["louis"] }),
      say("ถอนชื่อ louis ออกจากรอบให้แล้วครับ 👍"),
    ]);

    const body = messageTexts(await send("บอทจ๋า ยังไม่ให้ louis ตีแบด น่าสงสารขนาดไหน 555"));

    expect(body).toBe("ℹ️ louis ไม่ได้อยู่ในรายชื่อรอบนี้");
    expect(await joinedNames()).toEqual([]);
  });

  it("พิมพ์เป็นประโยคให้ถอนคนอื่น ต้องกดยืนยันก่อน ยังไม่ถอนจนกว่าจะกด", async () => {
    await send("บอทจ๋า ลงชื่อ กิ้ฟ");
    expect(await joinedNames()).toEqual(["กิ้ฟ"]);

    currentClient = fakeClient([call("leave_game", { names: ["กิ้ฟ"] }), say(LLM_OWN_WORDS)]);
    const card = await send("บอทจ๋า เอากิ้ฟออกด้วย");

    expect(messageTexts(card)).toContain("กิ้ฟ");
    expect(messageTexts(card)).not.toContain(LLM_OWN_WORDS);
    expect(await joinedNames()).toEqual(["กิ้ฟ"]);

    expect(messageTexts(await press("ถอนชื่อ", card))).toContain("give ツ ถอนชื่อให้ กิ้ฟ");
    expect(await joinedNames()).toEqual([]);
  });

  it("พิมพ์เป็นประโยคให้ถอนตัวเอง ถอนเลยไม่ต้องยืนยัน และขึ้นข้อความของระบบอย่างเดียว", async () => {
    await send("บอทจ๋า ลงชื่อ");

    currentClient = fakeClient([call("leave_game"), say(LLM_OWN_WORDS)]);
    const body = messageTexts(await send("บอทจ๋า ผมไม่ไปแล้วนะ"));

    expect(body).toContain("give ツ ถอนชื่อแล้ว");
    expect(body).not.toContain(LLM_OWN_WORDS);
    expect(await joinedNames()).toEqual([]);
  });

  it("พิมพ์เป็นประโยคให้ลงชื่อ ขึ้นข้อความของระบบอย่างเดียว", async () => {
    currentClient = fakeClient([call("join_game"), say(LLM_OWN_WORDS)]);
    const body = messageTexts(await send("บอทจ๋า คืนนี้ผมไปด้วย"));

    expect(body).toContain("give ツ ลงชื่อแล้ว");
    expect(body).not.toContain(LLM_OWN_WORDS);
  });
});

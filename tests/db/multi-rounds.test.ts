import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, createSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { handleEvent } from "@/line/handle-event";
import type { LineEvent } from "@/line/webhook-schema";
import { closeOverdueGames, insertGame, updateGameStatus } from "@/repositories/game.repository";
import { createPendingAction } from "@/repositories/pending-action.repository";
import { upsertGuest, upsertUser } from "@/repositories/user.repository";
import type { GameRow, LineUserRow, UserRow } from "@/repositories/types";
import { confirmCreateBill } from "@/services/bill.service";
import { confirmCreateGame } from "@/services/game.service";
import { canRunDbTests, createTestSql, TEST_SCHEMA, testLineUserId } from "./helpers";
import { buttonData, buttonLabels, messageTexts } from "../helpers";

const GROUP_ID = "C-test-multi-rounds";

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

/** Gemini ปลอมที่จดบทสนทนาที่ส่งไปแต่ละครั้ง ใช้ดูว่า LLM เห็นอะไรบ้าง */
function recordingClient(turns: GeminiTurn[], seen: unknown[]): GeminiClient {
  const inner = fakeClient(turns);
  return {
    async generate(request) {
      seen.push(request.contents);
      return inner.generate(request);
    },
  };
}

/** ข้อความที่ LLM แต่งเอง ใช้ดูว่ามันหลุดไปถึงแชทหรือเปล่า */
const LLM_OWN_WORDS = "ข้อความที่ LLM แต่งเอง";

let currentClient: GeminiClient = fakeClient([]);

// handle-event สร้าง client เองทุกครั้ง จึงต้องดักที่จุดสร้าง ไม่ใช่ส่งเข้าไปทางพารามิเตอร์
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  createGeminiClient: () => currentClient,
}));

type When = { playDate: string; startTime: string; courtName: string };

// วันที่รู้วันในสัปดาห์แน่นอน: 2030-01-16 เป็นวันพุธ 2030-01-19 เป็นวันเสาร์
const WED: When = { playDate: "2030-01-16", startTime: "19:00", courtName: "คอร์ทสามย่าน" };
const SAT: When = { playDate: "2030-01-19", startTime: "18:00", courtName: "ABC Badminton" };
const SUN: When = { playDate: "2030-01-20", startTime: "17:00", courtName: "คอร์ทบางนา" };

const WED_LABEL = "พุธ 16 ม.ค. 19:00";
const SAT_LABEL = "เสาร์ 19 ม.ค. 18:00";
const WED_BUTTON = `${WED_LABEL} · คอร์ทสามย่าน`;
const SAT_BUTTON = `${SAT_LABEL} · ABC Badminton`;

/** ร่างรอบที่ข้อมูลครบ ใช้กับการ์ดยืนยันเปิดรอบ */
const DRAFT = {
  court_count: 1,
  max_players: 8,
  play_date: "2030-02-01",
  start_time: "19:00",
  duration_minutes: 120,
  court_name: "คอร์ทใหม่",
};

/**
 * เปิดได้หลายรอบพร้อมกัน (PRP multi-open-rounds §10)
 * ทุกข้อความเดินผ่าน handleEvent เหมือนแชทจริง ส่วน Gemini เป็นตัวปลอมที่ตอบตามสคริปต์
 */
describe.skipIf(!canRunDbTests())("เปิดได้หลายรอบพร้อมกัน (ฐานข้อมูลจริง, schema bot_test)", () => {
  type Member = { lineUserId: string; user: LineUserRow };

  let sql: Sql;
  const lineUserIds: string[] = [];
  const displayNames = new Map<string, string>();
  let owner: Member;
  let give: Member;

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    // bill_shares, bill_items และ bill_item_payers หลุดตามด้วย ON DELETE CASCADE
    await sql`DELETE FROM bills WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM game_players WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
    await sql`DELETE FROM games WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
    await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
  }

  async function newMember(name: string): Promise<Member> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    displayNames.set(lineUserId, name);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  function openRound(createdBy: Member, when: When, courtCount = 1): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy: createdBy.user.id,
        playDate: when.playDate,
        startTime: when.startTime,
        durationMinutes: 120,
        courtCount,
        maxPlayers: courtCount * 8,
        courtName: when.courtName,
      },
      sql,
    );
  }

  /** ลงชื่อตรง ๆ ในฐานข้อมูล ไม่ผ่าน service ที่กำลังเทส */
  async function addPlayer(game: GameRow, person: UserRow, addedBy: UserRow | null = null): Promise<void> {
    await sql`
      INSERT INTO game_players (game_id, user_id, status, added_by)
      VALUES (${game.id}, ${person.id}, 'joined', ${addedBy?.id ?? null})
    `;
  }

  async function joinedIn(game: GameRow): Promise<string[]> {
    const rows = await sql<{ display_name: string }[]>`
      SELECT u.display_name FROM game_players gp JOIN users u ON u.id = gp.user_id
      WHERE gp.game_id = ${game.id} AND gp.status = 'joined'
      ORDER BY gp.id
    `;
    return rows.map((row) => row.display_name);
  }

  async function gameRow(game: GameRow): Promise<{ status: string; court_count: number }> {
    const rows = await sql<{ status: string; court_count: number }[]>`
      SELECT status, court_count FROM games WHERE id = ${game.id}
    `;
    return rows[0]!;
  }

  async function openCount(): Promise<number> {
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM games WHERE line_group_id = ${GROUP_ID} AND status = 'open'
    `;
    return rows[0]!.count;
  }

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(async () => {
    await cleanup();
    currentClient = fakeClient([say("ได้เลยครับ")]);
    vi.stubEnv("GEMINI_API_KEY", "fake-key-value");
    // ชื่อผู้ใช้มาจาก LINE Profile API ระหว่างเทสไม่ยิงเน็ตจริง ตอบชื่อตาม userId ท้าย URL
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const lineUserId = decodeURIComponent(String(url).split("/").pop() ?? "");
        return new Response(JSON.stringify({ displayName: displayNames.get(lineUserId) ?? "สมาชิก" }), {
          status: 200,
        });
      }),
    );

    owner = await newMember("เชวง");
    give = await newMember("กิ้ฟ");
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

  /** สมาชิกพิมพ์ข้อความเข้ากลุ่ม คืนข้อความที่บอทตอบ (ว่าง = เงียบ) */
  function send(member: Member, text: string): Promise<LineMessage[]> {
    return deliver({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: member.lineUserId },
      message: { type: "text", text },
    } as LineEvent);
  }

  function postback(member: Member, data: string): Promise<LineMessage[]> {
    return deliver({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: member.lineUserId },
      postback: { data },
    } as LineEvent);
  }

  /** กดปุ่มชื่อนี้บนข้อความที่ระบุ ไม่เจอปุ่มถือว่าเทสผิด */
  function press(member: Member, label: string, on: LineMessage[]): Promise<LineMessage[]> {
    const data = buttonData(on, label);
    if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label} ใน: ${messageTexts(on)}`);
    return postback(member, data);
  }

  describe("ลงชื่อ ถอนชื่อ และรายชื่อ", () => {
    it("กลุ่มที่มีรอบเดียว ลงชื่อแล้วตอบเหมือนเดิม ไม่ถาม ไม่มีรอบต่อท้าย", async () => {
      await openRound(owner, WED);

      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อ"))).toBe("✅ กิ้ฟ ลงชื่อแล้ว\n👥 1/8 คน");
    });

    it("เปิดสองรอบ ลงชื่อแล้วถามว่ารอบไหน กดแล้วลงรอบที่เลือก และผลลัพธ์บอกรอบ", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      const card = await send(give, "บอทจ๋า ลงชื่อ");
      expect(messageTexts(card)).toContain("ลงชื่อรอบไหน?");
      expect(buttonLabels(card[0])).toEqual([WED_BUTTON, SAT_BUTTON, "ยกเลิก"]);
      expect(await joinedIn(sat)).toEqual([]);

      const done = await press(give, SAT_BUTTON, card);
      expect(messageTexts(done)).toBe(`✅ กิ้ฟ ลงชื่อแล้ว (${SAT_LABEL})\n👥 1/8 คน`);
      expect(await joinedIn(sat)).toEqual(["กิ้ฟ"]);
      expect(await joinedIn(wed)).toEqual([]);
    });

    it("ลงไว้รอบหนึ่งแล้ว ลงชื่ออีกครั้งลงรอบที่เหลือเลย ไม่ถาม", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(wed, give.user);

      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อ"))).toBe(`✅ กิ้ฟ ลงชื่อแล้ว (${SAT_LABEL})\n👥 1/8 คน`);
      expect(await joinedIn(sat)).toEqual(["กิ้ฟ"]);
    });

    it("ลงครบทุกรอบแล้ว หรือรอบที่เหลือเต็มหมด บอกเหตุผลตามจริง", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(wed, give.user);
      await addPlayer(sat, give.user);

      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อ"))).toBe("ℹ️ พี่ลงชื่อไว้ครบทุกรอบแล้วนะครับ");

      await sql`DELETE FROM game_players WHERE game_id = ${sat.id}`;
      for (let index = 1; index <= 8; index += 1) {
        await addPlayer(sat, await upsertGuest(GROUP_ID, `แขก ${index}`, sql));
      }
      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อ"))).toContain("รอบที่เหลือเต็มหมดแล้ว");
    });

    it("ถอนชื่อ: ลงไว้รอบเดียว ถอนเลยแม้กลุ่มเปิดอยู่หลายรอบ", async () => {
      await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(sat, give.user);

      expect(messageTexts(await send(give, "บอทจ๋า ถอนชื่อ"))).toBe(`👋 กิ้ฟ ถอนชื่อแล้ว (${SAT_LABEL})\n👥 0/8 คน`);
      expect(await joinedIn(sat)).toEqual([]);
    });

    it("ถอนชื่อ: ลงไว้สองรอบ ถามก่อนว่าถอนจากรอบไหน (เคสที่ผู้ใช้ขอ)", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(wed, give.user);
      await addPlayer(sat, give.user);

      const card = await send(give, "บอทจ๋า ถอนชื่อ");
      expect(messageTexts(card)).toContain("ถอนจากรอบไหน?");
      expect(await joinedIn(wed)).toEqual(["กิ้ฟ"]);

      const done = await press(give, WED_BUTTON, card);
      expect(messageTexts(done)).toBe(`👋 กิ้ฟ ถอนชื่อแล้ว (${WED_LABEL})\n👥 0/8 คน`);
      expect(await joinedIn(wed)).toEqual([]);
      expect(await joinedIn(sat)).toEqual(["กิ้ฟ"]);
    });

    it("การ์ดรอบไหนกดได้เฉพาะคนสั่ง กดได้ครั้งเดียว และกดยกเลิกได้", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      const card = await send(give, "บอทจ๋า ลงชื่อ");
      expect(await press(owner, SAT_BUTTON, card)).toEqual([]);
      expect(await joinedIn(sat)).toEqual([]);

      await press(give, SAT_BUTTON, card);
      expect(await press(give, WED_BUTTON, card)).toEqual([]);
      expect(await joinedIn(wed)).toEqual([]);
      expect(await joinedIn(sat)).toEqual(["กิ้ฟ"]);

      const another = await send(owner, "บอทจ๋า ลงชื่อ");
      expect(messageTexts(await press(owner, "ยกเลิก", another))).toContain("ยังไม่ได้ทำอะไร");
      expect(await joinedIn(wed)).toEqual([]);
    });

    it("ถอนแขกที่อยู่สองรอบด้วยคำสั่งพิมพ์ ถามรอบไหน กดแล้วถอนเฉพาะรอบนั้น", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      const wit = await upsertGuest(GROUP_ID, "วิท", sql);
      await addPlayer(wed, wit, give.user);
      await addPlayer(sat, wit, give.user);

      const card = await send(give, "บอทจ๋า ถอนชื่อ วิท");
      expect(messageTexts(card)).toContain("ถอนจากรอบไหน?");

      const done = await press(give, SAT_BUTTON, card);
      expect(messageTexts(done)).toContain(`กิ้ฟ ถอนชื่อให้ วิท (${SAT_LABEL})`);
      expect(await joinedIn(sat)).toEqual([]);
      expect(await joinedIn(wed)).toEqual(["วิท"]);
    });

    it("ถอนคนอื่นผ่านประโยคตอนเขาอยู่หลายรอบ กดเลือกรอบแล้วถอนเลย ไม่ต้องยืนยันซ้ำ", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      const wit = await upsertGuest(GROUP_ID, "วิท", sql);
      await addPlayer(wed, wit, give.user);
      await addPlayer(sat, wit, give.user);

      currentClient = fakeClient([call("leave_game", { names: ["วิท"] }), say(LLM_OWN_WORDS)]);
      const card = await send(give, "บอทจ๋า เอาวิทออกด้วย");
      expect(messageTexts(card)).toContain("ถอนจากรอบไหน?");
      expect(messageTexts(card)).not.toContain(LLM_OWN_WORDS);

      const done = await press(give, WED_BUTTON, card);
      expect(messageTexts(done)).toContain("กิ้ฟ ถอนชื่อให้ วิท");
      expect(await joinedIn(wed)).toEqual([]);
      expect(await joinedIn(sat)).toEqual(["วิท"]);
    });

    it("พิมพ์ตอบว่ารอบไหนแทนการกดปุ่มได้ เพราะ LLM เห็นคำถามในบทสนทนา", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(wed, give.user);
      await addPlayer(sat, give.user);

      expect(messageTexts(await send(give, "บอทจ๋า ถอนชื่อ"))).toContain("ถอนจากรอบไหน?");

      const seen: unknown[] = [];
      currentClient = recordingClient([call("leave_game", { round_date: "2030-01-19" }), say(LLM_OWN_WORDS)], seen);
      const reply = await send(give, "เสาร์");

      expect(JSON.stringify(seen[0])).toContain("ถอนจากรอบไหน?");
      expect(messageTexts(reply)).toBe(`👋 กิ้ฟ ถอนชื่อแล้ว (${SAT_LABEL})\n👥 0/8 คน`);
      expect(await joinedIn(sat)).toEqual([]);
      expect(await joinedIn(wed)).toEqual(["กิ้ฟ"]);
    });

    it("ถอนชื่อคนที่ไม่ได้อยู่รอบไหนเลย บอกว่าไม่อยู่ในรายชื่อรอบไหนเลย", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);

      expect(messageTexts(await send(give, "บอทจ๋า ถอนชื่อ louis"))).toBe("ℹ️ louis ไม่ได้อยู่ในรายชื่อรอบไหนเลย");
    });

    it("ใครตีบ้าง แสดงรายชื่อทุกรอบในคำตอบเดียว ไม่ถาม", async () => {
      const wed = await openRound(owner, WED);
      await openRound(owner, SAT);
      await addPlayer(wed, give.user);

      const reply = await send(owner, "บอทจ๋า ใครตีบ้าง");
      expect(reply).toHaveLength(2);
      expect(messageTexts([reply[0]])).toContain("คอร์ทสามย่าน");
      expect(messageTexts([reply[0]])).toContain("1. กิ้ฟ");
      expect(messageTexts([reply[1]])).toContain("ABC Badminton");
    });

    it("ปุ่มลงชื่อแบบเก่าที่ค้างในแชท ทำเหมือนพิมพ์คำสั่ง ถามว่ารอบไหน", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);

      expect(messageTexts(await postback(give, "action=join"))).toContain("ลงชื่อรอบไหน?");
    });
  });

  describe("เปิดรอบได้สูงสุด 3 รอบ", () => {
    it("เปิดรอบใหม่ได้ขณะที่มีรอบอื่นเปิดอยู่", async () => {
      await openRound(owner, WED);

      expect(messageTexts(await send(owner, "บอทจ๋า เปิดตี"))).toContain("กี่คอร์ท");
    });

    it("เปิดครบ 3 รอบแล้ว รอบที่ 4 ไม่ให้เริ่มถาม พร้อมบอกรอบที่เปิดอยู่", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);
      await openRound(give, SUN);

      const body = messageTexts(await send(owner, "บอทจ๋า เปิดตี"));
      expect(body).toContain("กลุ่มนี้เปิดรอบไว้ครบ 3 รอบแล้ว");
      expect(body).toContain("คอร์ทสามย่าน");
      expect(body).toContain("ABC Badminton");
      expect(body).toContain("คอร์ทบางนา");

      const pending = await sql`
        SELECT id FROM pending_actions WHERE line_group_id = ${GROUP_ID} AND action_type = 'create_game'
      `;
      expect(pending).toHaveLength(0);
    });

    it("การ์ดยืนยันที่ค้างไว้ตอนมี 2 รอบ กดตอนครบ 3 รอบแล้วเปิดไม่ได้", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);
      const pending = await createPendingAction(
        { lineGroupId: GROUP_ID, requestedBy: owner.user.id, actionType: "create_game", payload: DRAFT },
        sql,
      );
      await openRound(give, SUN);

      const reply = await postback(owner, new URLSearchParams({ action: "confirm", pending_id: pending.id }).toString());
      expect(messageTexts(reply)).toContain("ครบ 3 รอบแล้ว");
      expect(await openCount()).toBe(3);
    });

    it("สองคนกดยืนยันเปิดรอบพร้อมกันตอนมี 2 รอบ ได้รอบเพิ่มแค่รอบเดียว", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);
      const first = await createPendingAction(
        { lineGroupId: GROUP_ID, requestedBy: owner.user.id, actionType: "create_game", payload: DRAFT },
        sql,
      );
      const second = await createPendingAction(
        { lineGroupId: GROUP_ID, requestedBy: give.user.id, actionType: "create_game", payload: DRAFT },
        sql,
      );

      // connection เดียวจะทำให้กลายเป็นคิว ต้องใช้หลาย connection ถึงจะแย่งกันจริง
      const concurrent = createSql(process.env.DATABASE_URL!, TEST_SCHEMA, { max: 2 });
      try {
        const results = await Promise.allSettled([
          confirmCreateGame(first.id, GROUP_ID, owner.user.id, concurrent),
          confirmCreateGame(second.id, GROUP_ID, give.user.id, concurrent),
        ]);

        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected" && result.reason?.code === "GAME_LIMIT_REACHED"),
        ).toHaveLength(1);
      } finally {
        await concurrent.end({ timeout: 5 });
      }

      expect(await openCount()).toBe(3);
    });
  });

  describe("แก้ไข ยกเลิก ปิดรอบ", () => {
    it("ดูเฉพาะรอบที่ตัวเองเปิด เหลือรอบเดียวขึ้นการ์ดยืนยันของรอบนั้นเลย", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(give, SAT);

      const confirm = await send(give, "บอทจ๋า ปิดรอบ");
      expect(messageTexts(confirm)).toContain("ปิดรอบตีนี้?");
      expect(messageTexts(confirm)).toContain("ABC Badminton");

      await press(give, "ปิดรอบ", confirm);
      expect((await gameRow(sat)).status).toBe("completed");
      expect((await gameRow(wed)).status).toBe("open");
    });

    it("เปิดไว้สองรอบ ถามว่าปิดรอบไหน กดแล้วยืนยัน ปิดเฉพาะรอบที่เลือก", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      const card = await send(owner, "บอทจ๋า ปิดรอบ");
      expect(messageTexts(card)).toContain("ปิดรอบไหน?");

      const confirm = await press(owner, WED_BUTTON, card);
      expect(messageTexts(confirm)).toContain("คอร์ทสามย่าน");

      await press(owner, "ปิดรอบ", confirm);
      expect((await gameRow(wed)).status).toBe("completed");
      expect((await gameRow(sat)).status).toBe("open");
    });

    it("ยกเลิกรอบที่เลือกจากการ์ด ยกเลิกเฉพาะรอบนั้น", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      const card = await send(owner, "บอทจ๋า ยกเลิก");
      const confirm = await press(owner, SAT_BUTTON, card);
      await press(owner, "ยืนยันยกเลิก", confirm);

      expect((await gameRow(sat)).status).toBe("cancelled");
      expect((await gameRow(wed)).status).toBe("open");
    });

    it("แก้ไขรอบที่เลือก แก้เฉพาะรอบนั้น", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      const card = await send(owner, "บอทจ๋า แก้ไข");
      expect(messageTexts(card)).toContain("แก้รอบไหน?");

      const menu = await press(owner, SAT_BUTTON, card);
      const question = await press(owner, "จำนวนคอร์ท", menu);
      const confirm = await press(owner, "2 คอร์ท", question);
      expect(messageTexts(confirm)).toContain("ยืนยันการแก้ไข?");

      expect(messageTexts(await press(owner, "ยืนยัน", confirm))).toContain("แก้ไขรอบเรียบร้อย");
      expect((await gameRow(sat)).court_count).toBe(2);
      expect((await gameRow(wed)).court_count).toBe(1);
    });

    it("ไม่ได้เปิดรอบไหนเลย แก้ไขไม่ได้", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);

      expect(messageTexts(await send(give, "บอทจ๋า แก้ไข"))).toContain("ทำได้เฉพาะคนที่เปิดรอบ");
    });

    it("การ์ดรอบไหนของรอบที่ถูกปิดไปแล้ว กดแล้วไม่มีผล", async () => {
      const wed = await openRound(owner, WED);
      await openRound(owner, SAT);

      const card = await send(owner, "บอทจ๋า ยกเลิก");
      await updateGameStatus(wed.id, "completed", sql);

      expect(await press(owner, WED_BUTTON, card)).toEqual([]);
      expect((await gameRow(wed)).status).toBe("completed");
    });
  });

  describe("คิดค่ารอบ", () => {
    it("มีสองรอบของตัวเองที่มีคนลงชื่อ ถามว่าคิดค่ารอบไหน กดแล้วได้บิลของรอบนั้น", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);
      await addPlayer(wed, give.user);
      await addPlayer(sat, give.user);

      const menu = await send(owner, "บอทจ๋า คิดเงิน");
      const which = await press(owner, "คิดค่ารอบ", menu);
      expect(messageTexts(which)).toContain("คิดค่ารอบไหน?");

      expect(messageTexts(await press(owner, SAT_BUTTON, which))).toContain("ค่าคอร์ทเท่าไหร่?");
      const pending = await sql<{ game_id: string; title: string }[]>`
        SELECT game_id, payload ->> 'title' AS title FROM pending_actions
        WHERE line_group_id = ${GROUP_ID} AND action_type = 'create_bill' AND used_at IS NULL
      `;
      expect(pending).toEqual([{ game_id: sat.id, title: "รอบ เสาร์ 19 ม.ค." }]);
    });

    it("เกมที่เพิ่งปิดยังคิดค่ารอบได้ ส่วนเกมที่ยกเลิกและเกมที่ปิดเกิน 7 วันไม่ขึ้น", async () => {
      const recent = await openRound(owner, WED);
      const cancelled = await openRound(owner, SAT);
      const old = await openRound(owner, SUN);
      for (const game of [recent, cancelled, old]) await addPlayer(game, give.user);

      await updateGameStatus(recent.id, "completed", sql);
      await updateGameStatus(cancelled.id, "cancelled", sql);
      await updateGameStatus(old.id, "completed", sql);
      await sql`UPDATE games SET updated_at = now() - interval '8 days' WHERE id = ${old.id}`;

      const menu = await send(owner, "บอทจ๋า คิดเงิน");
      expect(messageTexts(menu)).toContain("พุธ 16 ม.ค.");
      expect(messageTexts(menu)).not.toContain("เสาร์ 19 ม.ค.");
      expect(messageTexts(menu)).not.toContain("อาทิตย์ 20 ม.ค.");

      expect(messageTexts(await press(owner, "คิดค่ารอบ", menu))).toContain("ค่าคอร์ทเท่าไหร่?");
      const pending = await sql<{ game_id: string }[]>`
        SELECT game_id FROM pending_actions
        WHERE line_group_id = ${GROUP_ID} AND action_type = 'create_bill' AND used_at IS NULL
      `;
      expect(pending).toEqual([{ game_id: recent.id }]);
    });
  });

  describe("LLM เลือกรอบ", () => {
    it("ระบุวันมา ลงชื่อรอบนั้นเลย", async () => {
      await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      currentClient = fakeClient([call("join_game", { round_date: "2030-01-19" }), say(LLM_OWN_WORDS)]);
      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อรอบวันเสาร์"))).toBe(
        `✅ กิ้ฟ ลงชื่อแล้ว (${SAT_LABEL})\n👥 1/8 คน`,
      );
      expect(await joinedIn(sat)).toEqual(["กิ้ฟ"]);
    });

    it("สองรอบวันเดียวกัน ระบุแค่วันได้การ์ดรอบไหน ระบุเวลาด้วยลงรอบนั้นเลย", async () => {
      await openRound(owner, SAT);
      const late = await openRound(owner, { playDate: "2030-01-19", startTime: "20:00", courtName: "คอร์ทบางนา" });

      currentClient = fakeClient([call("join_game", { round_date: "2030-01-19" }), say(LLM_OWN_WORDS)]);
      const card = await send(give, "บอทจ๋า ลงชื่อรอบวันเสาร์");
      expect(messageTexts(card)).toContain("ลงชื่อรอบไหน?");
      expect(messageTexts(card)).not.toContain(LLM_OWN_WORDS);

      currentClient = fakeClient([
        call("join_game", { round_date: "2030-01-19", round_time: "20:00" }),
        say(LLM_OWN_WORDS),
      ]);
      await send(give, "บอทจ๋า ลงชื่อรอบสองทุ่มวันเสาร์");
      expect(await joinedIn(late)).toEqual(["กิ้ฟ"]);
    });

    it("ไม่ระบุรอบแล้วกำกวม ระบบขึ้นการ์ดรอบไหนเอง ไม่ใช่ข้อความของ LLM", async () => {
      await openRound(owner, WED);
      await openRound(owner, SAT);

      currentClient = fakeClient([call("join_game"), say(LLM_OWN_WORDS)]);
      const reply = await send(give, "บอทจ๋า ผมไปด้วย");
      expect(messageTexts(reply)).toContain("ลงชื่อรอบไหน?");
      expect(messageTexts(reply)).not.toContain(LLM_OWN_WORDS);
    });

    it("ระบุวันที่ไม่มีรอบเปิดอยู่ บอกว่าไม่มีรอบวันนั้น", async () => {
      await openRound(owner, WED);

      currentClient = fakeClient([call("join_game", { round_date: "2030-01-17" }), say(LLM_OWN_WORDS)]);
      expect(messageTexts(await send(give, "บอทจ๋า ลงชื่อรอบวันพฤหัส"))).toContain("ไม่มีรอบ พฤหัส 17 ม.ค.");
    });

    it("เสนอแก้รอบโดยไม่บอกว่ารอบไหน เลือกรอบจากการ์ดแล้วได้การ์ดยืนยันพร้อมค่าที่เสนอไว้", async () => {
      const wed = await openRound(owner, WED);
      const sat = await openRound(owner, SAT);

      currentClient = fakeClient([call("propose_edit_game", { court_count: 2 }), say(LLM_OWN_WORDS)]);
      const card = await send(owner, "บอทจ๋า เพิ่มเป็น 2 คอร์ท");
      expect(messageTexts(card)).toContain("แก้รอบไหน?");
      expect(messageTexts(card)).not.toContain(LLM_OWN_WORDS);

      const confirm = await press(owner, SAT_BUTTON, card);
      expect(messageTexts(confirm)).toContain("1 → 2 คอร์ท");

      await press(owner, "ยืนยัน", confirm);
      expect((await gameRow(sat)).court_count).toBe(2);
      expect((await gameRow(wed)).court_count).toBe(1);
    });
  });

  /**
   * cron ปิดรอบของทุกกลุ่มในคำสั่งเดียว เทสจึงใช้ปี 2001 ซึ่งไม่มีเทสไฟล์ไหนใช้
   * "วันนี้" ที่ส่งเข้าไปจะได้ปิดเฉพาะรอบของไฟล์นี้ ไม่ไปปิดรอบของไฟล์อื่นที่รันพร้อมกัน
   */
  describe("ปิดรอบอัตโนมัติ", () => {
    const PAST: When = { playDate: "2001-01-01", startTime: "19:00", courtName: "คอร์ทเก่า" };
    const TODAY = "2001-01-02";

    it("ปิดเฉพาะรอบที่วันเล่นผ่านไปแล้ว รอบของวันนี้ยังเปิดอยู่", async () => {
      const past = await openRound(owner, PAST);
      const today = await openRound(owner, { ...PAST, playDate: TODAY });

      expect(await closeOverdueGames(TODAY, sql)).toBe(1);
      expect((await gameRow(past)).status).toBe("completed");
      expect((await gameRow(today)).status).toBe("open");

      // เวลาที่ปิดใช้ตัดสินว่าเกมนี้ยังคิดค่ารอบได้ไหม (PRP §5.1)
      const rows = await sql<{ fresh: boolean }[]>`
        SELECT updated_at > now() - interval '1 minute' AS fresh FROM games WHERE id = ${past.id}
      `;
      expect(rows[0]?.fresh).toBe(true);
    });

    it("ปิดอัตโนมัติแล้ว บิลของรอบนั้นยังบอกจ่ายแล้วได้ และการ์ดค้างของรอบนั้นกดไม่มีผล", async () => {
      const past = await openRound(owner, PAST);
      await addPlayer(past, owner.user);
      await addPlayer(past, give.user);

      const billPending = await createPendingAction(
        {
          lineGroupId: GROUP_ID,
          requestedBy: owner.user.id,
          actionType: "create_bill",
          gameId: past.id,
          payload: { title: "รอบเก่า", court_fee: 400, shuttle_count: 0, extras_done: true },
        },
        sql,
      );
      await confirmCreateBill(billPending.id, GROUP_ID, owner.user.id);

      const menu = await send(owner, "บอทจ๋า แก้ไข");
      expect(messageTexts(menu)).toContain("ต้องการแก้ไขอะไร?");

      await closeOverdueGames(TODAY, sql);

      expect(messageTexts(await send(give, "บอทจ๋า จ่ายแล้ว"))).toContain("กิ้ฟ");
      const shares = await sql<{ paid: boolean }[]>`
        SELECT bs.paid FROM bill_shares bs JOIN bills b ON b.id = bs.bill_id
        WHERE b.line_group_id = ${GROUP_ID} AND bs.user_id = ${give.user.id}
      `;
      expect(shares).toEqual([{ paid: true }]);

      expect(await press(owner, "จำนวนคอร์ท", menu)).toEqual([]);
    });
  });
});

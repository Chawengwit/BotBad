import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { handleEvent } from "@/line/handle-event";
import type { LineEvent } from "@/line/webhook-schema";
import { insertGame } from "@/repositories/game.repository";
import {
  closeListeningWindow,
  isListening,
  openListeningWindow,
} from "@/repositories/session.repository";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { messageTexts } from "../helpers";

const GROUP_ID = "C-test-listening";
const ACCESS_TOKEN = "test-access-token";

/** Gemini ปลอม จำไว้ด้วยว่าถูกเรียกไปกี่ครั้ง จะได้เช็กว่าที่กรองออกไม่ได้เสียโควตาจริง */
function fakeClient(turns: GeminiTurn[]): GeminiClient & { calls: number } {
  const client = {
    calls: 0,
    async generate() {
      const turn = turns[Math.min(client.calls, turns.length - 1)];
      client.calls += 1;
      return turn ?? { text: "", calls: [] };
    },
  };
  return client;
}

const say = (text: string): GeminiTurn => ({ text, calls: [] });
const call = (name: string, args: Record<string, unknown> = {}): GeminiTurn => ({
  text: "",
  calls: [{ name, args }],
});

let currentClient: GeminiClient & { calls: number };

// handle-event สร้าง client เองทุกครั้ง จึงต้องดักที่จุดสร้าง ไม่ใช่ส่งเข้าไปทางพารามิเตอร์
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  createGeminiClient: () => currentClient,
}));

describe.skipIf(!canRunDbTests())("โหมดฟัง (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];
  let replies: LineMessage[][];

  /** ส่งข้อความเข้ากลุ่มเหมือน LINE ส่ง webhook มา คืนข้อความที่บอทตอบ (ว่าง = เงียบ) */
  async function send(lineUserId: string, text: string): Promise<LineMessage[]> {
    const event: LineEvent = {
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
      message: { type: "text", text },
    } as LineEvent;

    const before = replies.length;
    await handleEvent(event, {
      accessToken: ACCESS_TOKEN,
      reply: async (_token, messages) => {
        replies.push(messages);
      },
    });
    return replies[before] ?? [];
  }

  function newUserId(): string {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return lineUserId;
  }

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
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
    replies = [];
    currentClient = fakeClient([say("ได้เลยครับ")]);
    vi.stubEnv("GEMINI_API_KEY", "fake-key-value");

    // ชื่อผู้ใช้มาจาก LINE Profile API ระหว่างเทสไม่ยิงเน็ตจริง
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "สมชาย" }), { status: 200 })),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closeSql();
  });

  describe("เปิดและปิดหน้าต่าง", () => {
    it("เรียกชื่อเฉย ๆ ได้คำทักและเปิดโหมดฟัง", async () => {
      const lineUserId = newUserId();

      const messages = await send(lineUserId, "บอทจ๋า");

      expect(messageTexts(messages)).toContain("ว่าไงครับ");
      expect(await isListening(GROUP_ID, lineUserId)).toBe(true);
      // ทักทายเฉย ๆ ไม่ต้องเสียโควตา LLM
      expect(currentClient.calls).toBe(0);
    });

    it("คำสั่งที่จบในตัวไม่เปิดโหมดฟังค้างไว้", async () => {
      const lineUserId = newUserId();
      await openListeningWindow(GROUP_ID, lineUserId);

      await send(lineUserId, "บอทจ๋า ใครตีบ้าง");

      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("คำสั่งที่ต้องคุยต่อ เปิดโหมดฟังไว้ให้", async () => {
      const lineUserId = newUserId();

      await send(lineUserId, "บอทจ๋า เปิดตี");

      expect(await isListening(GROUP_ID, lineUserId)).toBe(true);
    });

    it("สั่งปิดเองด้วย \"บอทจ๋า พอแล้ว\"", async () => {
      const lineUserId = newUserId();
      await openListeningWindow(GROUP_ID, lineUserId);

      const messages = await send(lineUserId, "บอทจ๋า พอแล้ว");

      expect(messageTexts(messages)).toContain("ได้เลยครับ");
      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("หมดอายุแล้วถือว่าไม่ได้อยู่ในโหมดฟัง", async () => {
      const lineUserId = newUserId();
      await openListeningWindow(GROUP_ID, lineUserId);
      await sql`
        UPDATE conversation_sessions SET listening_until = now() - interval '1 second'
        WHERE line_group_id = ${GROUP_ID} AND line_user_id = ${lineUserId}
      `;

      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("ปิดโหมดฟังแล้วยังเก็บบทสนทนาไว้ ไม่ได้ลบทั้งแถว", async () => {
      const lineUserId = newUserId();
      await openListeningWindow(GROUP_ID, lineUserId);
      await closeListeningWindow(GROUP_ID, lineUserId);

      const rows = await sql`
        SELECT listening_until FROM conversation_sessions
        WHERE line_group_id = ${GROUP_ID} AND line_user_id = ${lineUserId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.listening_until).toBeNull();
    });
  });

  describe("ระหว่างอยู่ในโหมดฟัง", () => {
    it("คนที่เรียกบอทพิมพ์ต่อได้เลยโดยไม่ต้องมี wake word", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า");

      const messages = await send(lineUserId, "รอบพรุ่งนี้คนเต็มยัง");

      expect(currentClient.calls).toBe(1);
      expect(messageTexts(messages)).toContain("ได้เลยครับ");
    });

    it("คนอื่นในกลุ่มพิมพ์ บอทต้องเงียบ", async () => {
      const caller = newUserId();
      const bystander = newUserId();
      await send(caller, "บอทจ๋า");

      const messages = await send(bystander, "เดี๋ยวเจอกันนะทุกคน");

      expect(messages).toEqual([]);
      expect(currentClient.calls).toBe(0);
    });

    it("ไม่ได้อยู่ในโหมดฟังก็เงียบเหมือนเดิม", async () => {
      const lineUserId = newUserId();

      const messages = await send(lineUserId, "เปิดตีพรุ่งนี้");

      expect(messages).toEqual([]);
      expect(currentClient.calls).toBe(0);
    });

    it("คำรับคำสั้น ๆ ปิดโหมดฟังโดยไม่เสียโควตา LLM", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า");

      const messages = await send(lineUserId, "โอเค");

      expect(messages).toEqual([]);
      expect(currentClient.calls).toBe(0);
      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("LLM บอกว่าไม่เกี่ยวกับบอท ต้องเงียบและปิดโหมดฟัง", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า");
      currentClient = fakeClient([say("IGNORE")]);

      const messages = await send(lineUserId, "เมื่อวานดูบอลไหม");

      expect(messages).toEqual([]);
      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
      // ข้อความที่ไม่เกี่ยวต้องไม่ถูกจำไว้เป็นบริบท
      const rows = await sql<{ messages: unknown[] }[]>`
        SELECT messages FROM conversation_sessions
        WHERE line_group_id = ${GROUP_ID} AND line_user_id = ${lineUserId}
      `;
      expect(rows[0]?.messages).toEqual([]);
    });

    it("ตีความไม่ออกก็เงียบ ไม่พ่นเมนูใส่กลุ่ม", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า");
      currentClient = fakeClient([say("")]);

      const messages = await send(lineUserId, "ตกลงว่าไงนะ");

      expect(messages).toEqual([]);
      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("ทำงานสำเร็จแล้วปิดโหมดฟังทันที", async () => {
      const lineUserId = newUserId();
      const game = await insertGame(
        {
          lineGroupId: GROUP_ID,
          createdBy: (await sql<{ id: string }[]>`
            INSERT INTO users (line_user_id, display_name) VALUES (${lineUserId}, 'สมชาย')
            ON CONFLICT (line_user_id) DO UPDATE SET display_name = EXCLUDED.display_name
            RETURNING id
          `)[0]!.id,
          playDate: "2030-01-15",
          startTime: "19:00",
          durationMinutes: 120,
          courtCount: 2,
          maxPlayers: 16,
          courtName: "คอร์ททดสอบ",
        },
        sql,
      );
      expect(game.id).toBeTruthy();

      await send(lineUserId, "บอทจ๋า");
      currentClient = fakeClient([call("join_game"), say("ลงชื่อให้แล้วครับ")]);

      await send(lineUserId, "ผมไปด้วยนะ");

      expect(await isListening(GROUP_ID, lineUserId)).toBe(false);
    });

    it("ยังไม่จบเรื่อง เช่น ยังรอกดยืนยัน ต้องฟังต่อ", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า");
      currentClient = fakeClient([
        call("propose_create_game", {
          court_count: 2,
          play_date: "2030-01-15",
          start_time: "20:00",
          duration_minutes: 120,
          court_name: "ABC Badminton",
        }),
        say("กดปุ่มยืนยันด้านล่างได้เลย"),
      ]);

      await send(lineUserId, "เปิดตีพรุ่งนี้สองทุ่ม 2 คอร์ท ที่ ABC Badminton 2 ชั่วโมง");

      expect(await isListening(GROUP_ID, lineUserId)).toBe(true);
    });
  });

  describe("ไม่ทับทางเดิม", () => {
    it("คำตอบของ wizard ยังมาก่อนโหมดฟัง", async () => {
      const lineUserId = newUserId();
      await send(lineUserId, "บอทจ๋า เปิดตี");

      // เปิดตีจะถามจำนวนคอร์ทด้วยปุ่ม ยังไม่มีอะไรรอให้พิมพ์ตอบ
      // แต่โหมดฟังต้องเปิดอยู่ ผู้ใช้จึงพิมพ์บอกต่อได้เลย
      expect(await isListening(GROUP_ID, lineUserId)).toBe(true);
    });
  });
});

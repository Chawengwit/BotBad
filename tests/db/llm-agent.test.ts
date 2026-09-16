import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { runAgent } from "@/llm/agent";
import { insertGame } from "@/repositories/game.repository";
import { loadSessionMessages } from "@/repositories/session.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

const GROUP_ID = "C-test-llm";

type Recorded = { systemInstruction: string; contents: unknown[] };

/** Gemini ปลอม ตอบตามสคริปต์ที่กำหนดไว้ ไม่ยิงเน็ตจริง */
function fakeClient(turns: (GeminiTurn | Error)[], recorded: Recorded[] = []): GeminiClient {
  let index = 0;
  return {
    async generate({ systemInstruction, contents }) {
      recorded.push({ systemInstruction, contents: [...contents] });
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      if (turn instanceof Error) throw turn;
      return turn ?? { text: "", calls: [] };
    },
  };
}

const say = (text: string): GeminiTurn => ({ text, calls: [] });
const call = (name: string, args: Record<string, unknown> = {}): GeminiTurn => ({
  text: "",
  calls: [{ name, args }],
});

function messageTexts(messages: LineMessage[]): string {
  return messages
    .map((message) => (message.type === "text" ? message.text : message.template.text))
    .join("\n");
}

describe.skipIf(!canRunDbTests())("LLM agent (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM bill_shares WHERE bill_id IN (
      SELECT b.id FROM bills b JOIN games g ON g.id = b.game_id WHERE g.line_group_id = ${GROUP_ID}
    )`;
    await sql`DELETE FROM bills WHERE game_id IN (SELECT id FROM games WHERE line_group_id = ${GROUP_ID})`;
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
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name = "เชวง"): Promise<{ lineUserId: string; user: UserRow }> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  async function openGame(createdBy: string): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-15",
        startTime: "19:00",
        durationMinutes: 120,
        courtCount: 2,
        maxPlayers: 16,
        courtName: "คอร์ททดสอบ",
      },
      sql,
    );
  }

  function run(
    user: { lineUserId: string; user: UserRow },
    text: string,
    client: GeminiClient,
  ): Promise<LineMessage[]> {
    return runAgent({
      text,
      lineGroupId: GROUP_ID,
      lineUserId: user.lineUserId,
      user: user.user,
      client,
    });
  }

  it("เสนอเปิดรอบแล้วได้การ์ดยืนยัน ยังไม่เปิดจริง", async () => {
    const user = await newUser();

    const messages = await run(
      user,
      "พรุ่งนี้สองทุ่มเปิดตี 2 คอร์ท ที่ ABC Badminton 2 ชั่วโมง",
      fakeClient([
        call("propose_create_game", {
          court_count: 2,
          play_date: "2030-01-15",
          start_time: "20:00",
          duration_minutes: 120,
          court_name: "ABC Badminton",
        }),
        say("เรียบร้อย กดปุ่มยืนยันด้านล่างได้เลย"),
      ]),
    );

    expect(messageTexts(messages)).toContain("ยืนยันไหม");
    expect(messageTexts(messages)).toContain("ABC Badminton");

    // ยังไม่เปิดรอบจริง มีแค่รายการรอยืนยัน
    expect(await sql`SELECT id FROM games WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
    const pending = await sql<{ action_type: string }[]>`
      SELECT action_type FROM pending_actions WHERE line_group_id = ${GROUP_ID}
    `;
    expect(pending[0]).toMatchObject({ action_type: "create_game" });
  });

  it("สั่งคิดเงินด้วยประโยคเดียวแล้วได้การ์ดยืนยัน ยังไม่ส่งบิลจริง", async () => {
    const owner = await newUser();
    const game = await openGame(owner.user.id);
    await joinGame(GROUP_ID, owner.user.id);

    const messages = await run(
      owner,
      "คิดเงินหน่อย ค่าคอร์ท 600 ลูกแบด 4 ลูก ลูกละ 25",
      fakeClient([
        call("propose_create_bill", { court_fee: 600, shuttle_count: 4, shuttle_price: 25 }),
        say("กดปุ่มยืนยันด้านล่างได้เลย"),
      ]),
    );

    const text = messageTexts(messages);
    expect(text).toContain("รวม 700.00");
    expect(text).toContain("หาร 1 คน");

    expect(await sql`SELECT id FROM bills WHERE game_id = ${game.id}`).toHaveLength(0);
    const pending = await sql<{ action_type: string }[]>`
      SELECT action_type FROM pending_actions WHERE line_group_id = ${GROUP_ID}
    `;
    expect(pending[0]).toMatchObject({ action_type: "create_bill" });
  });

  it("คนที่ไม่ได้เปิดรอบสั่งคิดเงินไม่ได้ และ LLM ได้รู้เหตุผล", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.user.id);
    const other = await newUser("Bank");
    await joinGame(GROUP_ID, other.user.id);

    const recorded: Recorded[] = [];
    await run(
      other,
      "คิดเงินเลย ค่าคอร์ท 600",
      fakeClient(
        [call("propose_create_bill", { court_fee: 600 }), say("เฉพาะคนเปิดรอบเท่านั้นนะ")],
        recorded,
      ),
    );

    expect(JSON.stringify(recorded)).toContain("NOT_GAME_CREATOR");
    expect(await sql`SELECT id FROM bills`).toHaveLength(0);
  });

  it("บอกว่าโอนแล้วผ่าน LLM บันทึกให้เจ้าตัวเท่านั้น", async () => {
    const owner = await newUser("เชวง");
    const game = await openGame(owner.user.id);
    await joinGame(GROUP_ID, owner.user.id);

    const other = await newUser("Bank");
    await joinGame(GROUP_ID, other.user.id);

    const bill = await sql<{ id: string }[]>`
      INSERT INTO bills (game_id, created_by, items, total_satang)
      VALUES (${game.id}, ${owner.user.id}, ${sql.json([
        { label: "ค่าคอร์ท", quantity: 1, unit_price_satang: 20000, amount_satang: 20000 },
      ])}, 20000)
      RETURNING id
    `;
    await sql`
      INSERT INTO bill_shares (bill_id, user_id, amount_satang)
      VALUES (${bill[0]!.id}, ${owner.user.id}, 10000), (${bill[0]!.id}, ${other.user.id}, 10000)
    `;

    const messages = await run(
      other,
      "โอนแล้วนะ",
      fakeClient([call("mark_my_payment", { paid: true }), say("บันทึกแล้ว")]),
    );

    expect(messageTexts(messages)).toContain("Bank จ่าย 100.00");

    const rows = await sql<{ user_id: string; paid: boolean }[]>`
      SELECT user_id, paid FROM bill_shares WHERE bill_id = ${bill[0]!.id} ORDER BY user_id
    `;
    expect(rows.filter((row) => row.paid).map((row) => row.user_id)).toEqual([other.user.id]);
  });

  it("ข้อมูลไม่ครบจะไม่สร้างรายการค้างไว้", async () => {
    const user = await newUser();
    const recorded: Recorded[] = [];

    const messages = await run(
      user,
      "พรุ่งนี้เปิดตีหน่อย",
      fakeClient(
        [call("propose_create_game", { play_date: "2030-01-15" }), say("ขอทราบคอร์ทกับเวลาด้วยนะ")],
        recorded,
      ),
    );

    expect(messageTexts(messages)).toContain("ขอทราบคอร์ท");
    expect(await sql`SELECT id FROM pending_actions WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);

    // ผลของ tool ถูกส่งกลับเข้าไปให้ LLM อ่านต่อ
    const secondCall = JSON.stringify(recorded[1]?.contents ?? []);
    expect(secondCall).toContain("MISSING_FIELDS");
  });

  it("ลงชื่อผ่าน LLM ได้จริง", async () => {
    const owner = await newUser();
    await openGame(owner.user.id);
    const player = await newUser("Bank");

    const messages = await run(player, "คืนนี้ผมไปด้วยนะ", fakeClient([call("join_game"), say("ลงชื่อให้แล้ว")]));

    expect(messageTexts(messages)).toContain("Bank ลงชื่อแล้ว");
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM game_players WHERE user_id = ${player.user.id} AND status = 'joined'
    `;
    expect(rows[0]?.count).toBe(1);
  });

  it("คนที่ไม่ได้เปิดรอบสั่งยกเลิกไม่ได้ และ LLM ได้รู้เหตุผล", async () => {
    const owner = await newUser();
    await openGame(owner.user.id);
    const other = await newUser("Bank");
    const recorded: Recorded[] = [];

    const messages = await run(
      other,
      "ยกเลิกรอบนี้เลย",
      fakeClient([call("propose_cancel_game"), say("ยกเลิกได้เฉพาะคนเปิดรอบนะ")], recorded),
    );

    expect(messageTexts(messages)).toContain("เฉพาะคนเปิดรอบ");
    expect(JSON.stringify(recorded[1]?.contents ?? [])).toContain("NOT_GAME_CREATOR");
    const rows = await sql`SELECT status FROM games WHERE line_group_id = ${GROUP_ID}`;
    expect(rows[0]).toMatchObject({ status: "open" });
  });

  it("tool ที่ไม่มีอยู่จริงถูกปฏิเสธ ไม่ทำให้พัง", async () => {
    const user = await newUser();
    const recorded: Recorded[] = [];

    const messages = await run(
      user,
      "ลบข้อมูลทิ้งให้หน่อย",
      fakeClient([call("drop_all_games"), say("ทำแบบนั้นไม่ได้นะ")], recorded),
    );

    expect(messageTexts(messages)).toContain("ทำแบบนั้นไม่ได้");
    expect(JSON.stringify(recorded[1]?.contents ?? [])).toContain("INVALID_TOOL");
  });

  it("args ที่ผิด schema ถูกปฏิเสธก่อนถึงฐานข้อมูล", async () => {
    const user = await newUser();
    const recorded: Recorded[] = [];

    await run(
      user,
      "เปิดตี 99 คอร์ท",
      fakeClient([call("propose_create_game", { court_count: 99 }), say("คอร์ทได้สูงสุด 4")], recorded),
    );

    expect(JSON.stringify(recorded[1]?.contents ?? [])).toContain("INVALID_ARGUMENT");
    expect(await sql`SELECT id FROM pending_actions WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });

  it("วนเรียก tool ไม่จบ จะตกไปที่เมนูปุ่ม", async () => {
    const user = await newUser();

    const messages = await run(user, "เอาไงดี", fakeClient([call("get_open_game")]));

    expect(messageTexts(messages)).toContain("ลองเลือกคำสั่งด้านล่าง");
  });

  it("ตอบไม่เกิน 5 ข้อความ แม้ tool จะสร้างการ์ดมาเยอะ", async () => {
    const owner = await newUser();
    await openGame(owner.user.id);

    // list_players สร้าง 2 ข้อความต่อครั้ง วนครบ 3 รอบก็เกินที่ LINE รับได้แล้ว
    const messages = await run(owner, "ใครตีบ้าง", fakeClient([call("list_players")]));

    expect(messages.length).toBeLessThanOrEqual(5);
  });

  it("พังหลังทำงานไปแล้ว ต้องส่งการ์ดให้เห็น แต่ไม่หลอกว่ามีปุ่มยืนยัน", async () => {
    const owner = await newUser();
    await openGame(owner.user.id);
    const player = await newUser("Bank");

    // รอบแรกลงชื่อสำเร็จ รอบสองพัง (เช่น timeout)
    const client = fakeClient([call("join_game"), new Error("timeout")]);
    const messages = await run(player, "ผมไปด้วย", client);

    const body = messageTexts(messages);
    expect(body).toContain("Bank ลงชื่อแล้ว");
    expect(body).not.toContain("กดปุ่มยืนยัน");

    // งานทำไปแล้วจริง และบทสนทนาต้องถูกบันทึกไว้ ไม่ใช่หายไปเฉย ๆ
    const rows = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count FROM game_players WHERE user_id = ${player.user.id} AND status = 'joined'
    `;
    expect(rows[0]?.count).toBe(1);
    expect(await loadSessionMessages(GROUP_ID, player.lineUserId, sql)).toEqual([
      { role: "user", text: "ผมไปด้วย" },
    ]);
  });

  it("Gemini ล่มก็ยังตอบเมนูปุ่ม", async () => {
    const user = await newUser();

    const messages = await run(user, "เปิดตีหน่อย", fakeClient([new Error("503 quota exceeded")]));

    expect(messageTexts(messages)).toContain("ลองเลือกคำสั่งด้านล่าง");
  });

  it("ส่ง content ของ model กลับไปทั้งก้อน (thoughtSignature ของ Gemini 3)", async () => {
    const user = await newUser();
    const recorded: Recorded[] = [];

    // Gemini 3 บังคับว่า functionCall ที่ส่งกลับต้องมี thoughtSignature ติดไปด้วย
    // ถ้าเราประกอบ part ขึ้นใหม่เอง จะโดนปฏิเสธ 400 (เจอจากการทดสอบกับของจริง)
    const modelContent = {
      role: "model",
      parts: [
        {
          functionCall: { name: "get_open_game", args: {} },
          thoughtSignature: "signature-from-gemini",
        },
      ],
    };

    const client: GeminiClient = {
      async generate({ systemInstruction, contents }) {
        recorded.push({ systemInstruction, contents: [...contents] });
        return recorded.length === 1
          ? { text: "", calls: [{ name: "get_open_game", args: {} }], content: modelContent }
          : say("ยังไม่มีรอบเปิดอยู่นะ");
      },
    };

    await run(user, "มีรอบไหม", client);

    expect(JSON.stringify(recorded[1]?.contents ?? [])).toContain("signature-from-gemini");
  });

  it("จำบทสนทนาไว้ต่อรอบถัดไป", async () => {
    const user = await newUser();
    const recorded: Recorded[] = [];

    await run(user, "พรุ่งนี้ว่างไหม", fakeClient([say("ตอนนี้ยังไม่มีรอบเปิดอยู่นะ")], recorded));
    await run(user, "งั้นเปิดเลย", fakeClient([say("ได้เลย กี่คอร์ทดี?")], recorded));

    const stored = await loadSessionMessages(GROUP_ID, user.lineUserId, sql);
    expect(stored.map((message) => message.text)).toEqual([
      "พรุ่งนี้ว่างไหม",
      "ตอนนี้ยังไม่มีรอบเปิดอยู่นะ",
      "งั้นเปิดเลย",
      "ได้เลย กี่คอร์ทดี?",
    ]);

    // ข้อความเก่าถูกส่งเข้าไปใน prompt รอบที่สอง
    expect(JSON.stringify(recorded[1]?.contents ?? [])).toContain("พรุ่งนี้ว่างไหม");
  });

  it("system prompt บอกสถานะรอบที่เปิดอยู่จริง", async () => {
    const owner = await newUser();
    await openGame(owner.user.id);
    await joinGame(GROUP_ID, owner.user.id, sql);
    const recorded: Recorded[] = [];

    await run(owner, "ตอนนี้กี่คนแล้ว", fakeClient([say("ตอนนี้ 1 คน")], recorded));

    const prompt = recorded[0]?.systemInstruction ?? "";
    expect(prompt).toContain("คอร์ททดสอบ");
    expect(prompt).toContain("1/16 คน");
    expect(prompt).toContain("เป็นคนเปิดรอบนี้");
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { handleEvent } from "@/line/handle-event";
import type { LineEvent } from "@/line/webhook-schema";
import { insertGame } from "@/repositories/game.repository";
import { updatePendingPayload, type PendingPayload } from "@/repositories/pending-action.repository";
import { openListeningWindow } from "@/repositories/session.repository";
import { upsertGuest, upsertUser } from "@/repositories/user.repository";
import type { GameRow, LineUserRow, UserRow } from "@/repositories/types";
import { confirmCreateBill, markPayment, startCreateBill } from "@/services/bill.service";
import { joinGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, buttonLabels, messageTexts } from "../helpers";

const GROUP_ID = "C-test-bill-menu";
const ACCESS_TOKEN = "test-access-token";

type FakeClient = GeminiClient & { calls: number; prompts: string[] };

/** Gemini ปลอม ตอบตามสคริปต์ และจำ system prompt ไว้ตรวจว่าบอกงานที่กำลังทำถูกไหม */
function fakeClient(turns: GeminiTurn[]): FakeClient {
  const client: FakeClient = {
    calls: 0,
    prompts: [],
    async generate({ systemInstruction }) {
      client.prompts.push(systemInstruction);
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

let currentClient: FakeClient;

// handle-event สร้าง client เองทุกครั้ง จึงต้องดักที่จุดสร้าง ไม่ใช่ส่งเข้าไปทางพารามิเตอร์
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  createGeminiClient: () => currentClient,
}));

/** บิลในรูปที่ผู้ใช้ส่งมา: พิมพ์ชื่อบิลกับรายการมาในข้อความเดียว มีขีดนำหน้าและคำว่า "คิด" */
const LUCKY_SHOP = [
  "บิล ร้านโชคดี",
  "- ค่าข้าว 1500 คิด วิท ฮก กิ๊ฟ",
  "- ค่าแบด 600 คิด กิ๊ฟ วิท",
  "- ค่าน้ำ 100 คิด ฮก วิท",
].join("\n");

/** สิ่งที่ Gemini ควรอ่านได้จากข้อความข้างบน */
const LUCKY_SHOP_BILL = {
  title: "ร้านโชคดี",
  other_items: [
    { label: "ค่าข้าว", amount: 1500 },
    { label: "ค่าแบด", amount: 600 },
    { label: "ค่าน้ำ", amount: 100 },
  ],
  payers: [
    { label: "ค่าข้าว", names: ["วิท", "ฮก", "กิ๊ฟ"] },
    { label: "ค่าแบด", names: ["กิ๊ฟ", "วิท"] },
    { label: "ค่าน้ำ", names: ["ฮก", "วิท"] },
  ],
};

describe.skipIf(!canRunDbTests())("คิดเงินอะไรดี / บิลใหม่ / แก้บิล (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];
  let replies: LineMessage[][];

  async function deliver(event: LineEvent): Promise<LineMessage[]> {
    const before = replies.length;
    await handleEvent(event, {
      accessToken: ACCESS_TOKEN,
      reply: async (_token, messages) => {
        replies.push(messages);
      },
    });
    return replies[before] ?? [];
  }

  /** ส่งข้อความเข้ากลุ่มเหมือน LINE ส่ง webhook มา คืนข้อความที่บอทตอบ (ว่าง = เงียบ) */
  function send(lineUserId: string, text: string): Promise<LineMessage[]> {
    return deliver({
      type: "message",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
      message: { type: "text", text },
    } as LineEvent);
  }

  /** กดปุ่มชื่อนี้บนข้อความที่ระบุ (การ์ดเก่าที่ยังค้างในแชทก็กดได้) ไม่เจอปุ่มถือว่าเทสผิด */
  function press(lineUserId: string, label: string, on: LineMessage[]): Promise<LineMessage[]> {
    const data = buttonData(on, label);
    if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label}`);

    return deliver({
      type: "postback",
      replyToken: "reply-token",
      source: { type: "group", groupId: GROUP_ID, userId: lineUserId },
      postback: { data },
    } as LineEvent);
  }

  const labelsOf = (messages: LineMessage[]) => buttonLabels(messages.at(-1));

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

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  // Supabase free tier มีเพดาน connection และ pool ที่ไม่ได้ปิดจะค้างไว้จนจบ process
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(async () => {
    replies = [];
    currentClient = fakeClient([say("ได้เลยครับ")]);
    vi.stubEnv("GEMINI_API_KEY", "fake-key-value");

    // ชื่อผู้ใช้มาจาก LINE Profile API ระหว่างเทสไม่ยิงเน็ตจริง
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "เชวง" }), { status: 200 })),
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
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newMember(name = "เชวง"): Promise<{ lineUserId: string; user: LineUserRow }> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return { lineUserId, user: await upsertUser(lineUserId, name, sql) };
  }

  async function openGame(createdBy: string): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-18",
        startTime: "18:00",
        durationMinutes: 120,
        courtCount: 1,
        maxPlayers: 6,
        courtName: "คอร์ทสามย่าน",
        promptpay: "0812345678",
      },
      sql,
    );
  }

  /** บิลลอย ๆ ที่ส่งไปแล้ว: ค่าข้าว 900 เก็บสามคน + ค่าน้ำ 100 เก็บแบงค์คนเดียว */
  async function sentBill(owner: UserRow, bank: UserRow, gift: UserRow): Promise<void> {
    const { pending } = await startCreateBill(GROUP_ID, owner.id, "ร้านโชคดี");
    await updatePendingPayload(pending.id, {
      court_fee: null,
      shuttle_count: null,
      shuttle_price: null,
      other_items: [
        { label: "ค่าข้าว", amount: 900 },
        { label: "ค่าน้ำ", amount: 100 },
      ],
      item_payers: { ค่าข้าว: [owner.id, bank.id, gift.id], ค่าน้ำ: [bank.id] },
      extras_done: true,
      promptpay_asked: true,
    } as PendingPayload);
    await confirmCreateBill(pending.id, GROUP_ID, owner.id);
  }

  async function sharesByName(): Promise<Record<string, { amount: number; paid: boolean }>> {
    const rows = await sql<{ display_name: string; amount_satang: number; paid: boolean }[]>`
      SELECT u.display_name, bs.amount_satang::int AS amount_satang, bs.paid
      FROM bill_shares bs
      JOIN users u ON u.id = bs.user_id
      JOIN bills b ON b.id = bs.bill_id
      WHERE b.line_group_id = ${GROUP_ID} AND b.status = 'sent'
    `;
    return Object.fromEntries(rows.map((row) => [row.display_name, { amount: row.amount_satang, paid: row.paid }]));
  }

  async function itemLabels(): Promise<string[]> {
    const rows = await sql<{ label: string }[]>`
      SELECT bi.label FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.line_group_id = ${GROUP_ID} AND b.status = 'sent'
      ORDER BY bi.position
    `;
    return rows.map((row) => row.label);
  }

  describe("คิดเงินอะไรดี", () => {
    it("มีรอบที่คิดค่ารอบได้ ถามก่อนว่าเงินเรื่องไหน และการ์ดใช้ได้ครั้งเดียว", async () => {
      const owner = await newMember();
      await openGame(owner.user.id);
      await joinGame(GROUP_ID, owner.user.id);

      const menu = await send(owner.lineUserId, "บอทจ๋า คิดเงิน");
      expect(messageTexts(menu)).toContain("คิดเงินอะไรดี?");
      expect(labelsOf(menu)).toEqual(["คิดค่ารอบ", "สร้างบิลใหม่"]);

      expect(messageTexts(await press(owner.lineUserId, "คิดค่ารอบ", menu))).toContain("ค่าคอร์ทเท่าไหร่");

      // กดอีกปุ่มบนการ์ดเดิมต้องเงียบ ไม่เปิดงานที่สองซ้อน
      expect(await press(owner.lineUserId, "สร้างบิลใหม่", menu)).toEqual([]);
      expect(currentClient.calls).toBe(0);
    });

    /** เคสในรูปที่ผู้ใช้ส่งมา: เดิมตอบว่า "ยังไม่มีใครลงชื่อ เลยหารไม่ได้" แล้วจบ */
    it("รอบยังไม่มีใครลงชื่อ ไม่ต้องขึ้นการ์ด ไปขอรายละเอียดบิลใหม่เลยพร้อมบอกเหตุผล", async () => {
      const owner = await newMember();
      await openGame(owner.user.id);

      const prompt = messageTexts(await send(owner.lineUserId, "บอทจ๋า คิดเงิน"));

      expect(prompt).toContain("ยังไม่มีใครลงชื่อ เลยยังคิดค่ารอบไม่ได้");
      expect(prompt).toContain("พิมพ์ชื่อบิลกับรายการ");
      expect(prompt).not.toContain("หารไม่ได้");
      expect(currentClient.calls).toBe(0);
    });

    it("คนที่ไม่ได้สร้างบิล ไม่มีปุ่มแก้บิลของคนอื่น", async () => {
      const owner = await newMember();
      const other = await newMember("ฮก");
      const bank = await upsertGuest(GROUP_ID, "แบงค์", sql);
      const gift = await upsertGuest(GROUP_ID, "กิ้ฟ", sql);
      await sentBill(owner.user, bank, gift);

      expect(labelsOf(await send(owner.lineUserId, "บอทจ๋า คิดเงิน"))).toEqual(["สร้างบิลใหม่", "แก้บิลเดิม"]);
      // เหลือทางเดียวคือสร้างบิลใหม่ ไปทางนั้นเลย ไม่ขึ้นการ์ดที่มีปุ่มเดียว
      expect(messageTexts(await send(other.lineUserId, "บอทจ๋า คิดเงิน"))).toContain("พิมพ์ชื่อบิลกับรายการ");
    });

    it("Gemini เจอประโยคที่ไม่ชัดว่าเงินเรื่องไหน ขึ้นการ์ดเลือกแบบเดียวกับคำสั่ง", async () => {
      const owner = await newMember();
      await openGame(owner.user.id);
      await joinGame(GROUP_ID, owner.user.id);
      currentClient = fakeClient([call("start_bill"), say("เลือกได้เลยครับ")]);

      const reply = await send(owner.lineUserId, "บอทจ๋า คิดเงินหน่อยสิ");

      expect(messageTexts(reply)).toContain("คิดเงินอะไรดี?");
      expect(labelsOf(reply)).toEqual(["คิดค่ารอบ", "สร้างบิลใหม่"]);
    });
  });

  describe("สร้างบิลใหม่ด้วย Gemini", () => {
    it("พิมพ์ชื่อบิลกับรายการมาทีเดียว ได้บิลตามที่พิมพ์ พร้อมถามเลขพร้อมเพย์ของคนสร้าง", async () => {
      const owner = await newMember();
      await openGame(owner.user.id);
      await send(owner.lineUserId, "บอทจ๋า คิดเงิน");

      currentClient = fakeClient([call("propose_create_bill", LUCKY_SHOP_BILL), say("ขอเลขพร้อมเพย์ก่อนนะครับ")]);
      const asked = await send(owner.lineUserId, LUCKY_SHOP);

      // ไม่ถูกจับเป็นคำสั่งดูบิลแบบเดิม ("รอบนี้ยังไม่ได้คิดเงิน")
      expect(messageTexts(asked)).not.toContain("ยังไม่ได้คิดเงิน");
      expect(currentClient.prompts[0]).toContain("งานที่กำลังทำ: สร้างบิลใหม่");
      expect(messageTexts(asked)).toContain("เลขพร้อมเพย์");

      // เสนอเลขที่คนสร้างบิลเคยใช้กับรอบของตัวเอง
      const preview = await press(owner.lineUserId, "ใช้ 081-234-5678", asked);
      expect(messageTexts(preview)).toContain("ตรวจบิลก่อนส่ง");
      expect(messageTexts(preview)).toContain("พร้อมเพย์ 081-234-5678");

      expect(messageTexts(await press(owner.lineUserId, "ส่งบิล", preview))).toContain("คิดเงินแล้ว");

      const bills = await sql<{ title: string; game_id: string | null; promptpay: string }[]>`
        SELECT title, game_id, promptpay FROM bills WHERE line_group_id = ${GROUP_ID}
      `;
      expect(bills).toEqual([{ title: "ร้านโชคดี", game_id: null, promptpay: "0812345678" }]);
      // ยอดเดียวกับในรูป: วิท 850 ฮก 550 กิ๊ฟ 800
      expect(await sharesByName()).toEqual({
        วิท: { amount: 85000, paid: false },
        ฮก: { amount: 55000, paid: false },
        กิ๊ฟ: { amount: 80000, paid: false },
      });
    });

    it("พิมพ์เลขพร้อมเพย์เองก็ได้", async () => {
      const owner = await newMember();
      await openGame(owner.user.id);
      await send(owner.lineUserId, "บอทจ๋า คิดเงิน");
      currentClient = fakeClient([call("propose_create_bill", LUCKY_SHOP_BILL), say("ขอเลขพร้อมเพย์ก่อนนะครับ")]);
      await send(owner.lineUserId, LUCKY_SHOP);

      expect(messageTexts(await send(owner.lineUserId, "089-999-9999"))).toContain("พร้อมเพย์ 089-999-9999");
    });

    it("ตั้งชื่อบิลมากับคำสั่งแล้ว ขอแค่รายการ และใช้ชื่อนั้นแม้ Gemini ไม่ได้ส่งชื่อมา", async () => {
      const owner = await newMember();

      const prompt = messageTexts(await send(owner.lineUserId, "บอทจ๋า คิดเงิน ร้านโชคดี"));
      expect(prompt).toContain('รายการของบิล "ร้านโชคดี"');

      const { title: _title, ...withoutTitle } = LUCKY_SHOP_BILL;
      currentClient = fakeClient([call("propose_create_bill", withoutTitle), say("ขอเลขพร้อมเพย์ก่อนนะครับ")]);
      await send(owner.lineUserId, "ค่าข้าว 1500 วิท ฮก กิ๊ฟ\nค่าแบด 600 กิ๊ฟ วิท\nค่าน้ำ 100 ฮก วิท");

      expect(currentClient.prompts[0]).toContain('title "ร้านโชคดี"');
      const pending = await sql<{ title: string; awaiting: string }[]>`
        SELECT payload ->> 'title' AS title, payload ->> 'awaiting' AS awaiting
        FROM pending_actions WHERE line_group_id = ${GROUP_ID} AND used_at IS NULL
      `;
      expect(pending).toEqual([{ title: "ร้านโชคดี", awaiting: "bill_promptpay" }]);
    });

    it("บอกว่าไม่เอาแล้วระหว่างรอรายการ เลิกรอโดยไม่เรียก Gemini", async () => {
      const owner = await newMember();
      await send(owner.lineUserId, "บอทจ๋า คิดเงิน");

      expect(messageTexts(await send(owner.lineUserId, "ไม่เอาแล้ว"))).toContain("ยังไม่ได้คิดเงิน");
      expect(currentClient.calls).toBe(0);

      const waiting = await sql`
        SELECT id FROM pending_actions
        WHERE line_group_id = ${GROUP_ID} AND used_at IS NULL AND payload ->> 'awaiting' IS NOT NULL
      `;
      expect(waiting).toHaveLength(0);
    });

    it("Gemini เจอคนบอกว่าจะสร้างบิลใหม่แต่ยังไม่บอกรายการ ข้อความถัดไปมาที่บิลนี้", async () => {
      const owner = await newMember();
      currentClient = fakeClient([call("start_bill", { kind: "new" }), say("พิมพ์มาได้เลยครับ")]);

      expect(messageTexts(await send(owner.lineUserId, "บอทจ๋าจะสร้างการคิดเงินใหม่"))).toContain(
        "พิมพ์ชื่อบิลกับรายการ",
      );

      currentClient = fakeClient([call("propose_create_bill", LUCKY_SHOP_BILL), say("ขอเลขพร้อมเพย์ก่อนนะครับ")]);
      expect(messageTexts(await send(owner.lineUserId, LUCKY_SHOP))).toContain("เลขพร้อมเพย์");
    });

    it("ข้อความหลายบรรทัดที่ขึ้นต้นด้วยบิลในโหมดฟัง ส่งให้ Gemini ไม่ใช่คำสั่งดูบิล", async () => {
      const owner = await newMember();
      await openListeningWindow(GROUP_ID, owner.lineUserId);

      const reply = await send(owner.lineUserId, LUCKY_SHOP);

      expect(currentClient.calls).toBe(1);
      expect(messageTexts(reply)).not.toContain("ยังไม่ได้คิดเงิน");
    });
  });

  describe("แก้บิลเดิม", () => {
    /**
     * บิลตั้งต้น: ค่าข้าว 900 เก็บสามคน (คนละ 300) + ค่าน้ำ 100 เก็บแบงค์ → เชวง 300, แบงค์ 400, กิ้ฟ 300
     * เชวงกับแบงค์จ่ายแล้ว แก้โดยเพิ่มค่าขนม 60 ให้กิ้ฟ และลบค่าน้ำ
     */
    it("เพิ่ม ลบ แล้วยืนยัน คนที่ยอดเปลี่ยนกลับเป็นยังไม่จ่าย คนที่ยอดเท่าเดิมยังจ่ายแล้ว", async () => {
      const owner = await newMember();
      const bank = await upsertGuest(GROUP_ID, "แบงค์", sql);
      const gift = await upsertGuest(GROUP_ID, "กิ้ฟ", sql);
      await sentBill(owner.user, bank, gift);
      await markPayment(GROUP_ID, owner.user, [owner.user, bank], true);

      const menu = await send(owner.lineUserId, "บอทจ๋า คิดเงิน");
      const start = await press(owner.lineUserId, "แก้บิลเดิม", menu);
      // ยังไม่ได้แก้อะไร ยังไม่มีปุ่มยืนยัน
      expect(labelsOf(start)).toEqual(["เพิ่มรายการ", "ลบรายการ", "ยกเลิก"]);

      expect(messageTexts(await press(owner.lineUserId, "เพิ่มรายการ", start))).toContain("พิมพ์รายการที่จะเพิ่ม");
      const added = await send(owner.lineUserId, "ค่าขนม 60 กิ้ฟ");
      expect(messageTexts(added)).toContain("ค่าขนม (ใหม่)");

      const picker = await press(owner.lineUserId, "ลบรายการ", added);
      const removed = await press(owner.lineUserId, "ค่าน้ำ 100.00", picker);
      expect(messageTexts(removed)).toContain("แบงค์ บอกว่าจ่ายแล้ว แต่ยอดเปลี่ยน จะกลับเป็นยังไม่จ่าย");

      // การ์ดใบก่อนหน้ายังค้างในแชท กดยืนยันบนใบนั้นต้องไม่มีผล เพราะไม่ตรงกับของล่าสุด
      expect(await press(owner.lineUserId, "ยืนยันแก้บิล", added)).toEqual([]);
      expect(await itemLabels()).toEqual(["ค่าข้าว", "ค่าน้ำ"]);

      expect(messageTexts(await press(owner.lineUserId, "ยืนยันแก้บิล", removed))).toContain("แก้บิลแล้ว");
      expect(await itemLabels()).toEqual(["ค่าข้าว", "ค่าขนม"]);
      expect(await sharesByName()).toEqual({
        เชวง: { amount: 30000, paid: true },
        แบงค์: { amount: 30000, paid: false },
        กิ้ฟ: { amount: 36000, paid: false },
      });

      const total = await sql<{ total_satang: number }[]>`
        SELECT total_satang::int AS total_satang FROM bills WHERE line_group_id = ${GROUP_ID}
      `;
      expect(total[0]?.total_satang).toBe(96000);
    });

    it("กดยกเลิกบนการ์ดแก้บิล บิลเหมือนเดิมทุกอย่าง", async () => {
      const owner = await newMember();
      const bank = await upsertGuest(GROUP_ID, "แบงค์", sql);
      const gift = await upsertGuest(GROUP_ID, "กิ้ฟ", sql);
      await sentBill(owner.user, bank, gift);

      const start = await press(owner.lineUserId, "แก้บิลเดิม", await send(owner.lineUserId, "บอทจ๋า คิดเงิน"));
      const removed = await press(
        owner.lineUserId,
        "ค่าน้ำ 100.00",
        await press(owner.lineUserId, "ลบรายการ", start),
      );

      expect(messageTexts(await press(owner.lineUserId, "ยกเลิก", removed))).toContain("บิลยังเหมือนเดิม");
      expect(await itemLabels()).toEqual(["ค่าข้าว", "ค่าน้ำ"]);
    });

    it("พิมพ์รายการที่อ่านไม่ออก ถามใหม่ ไม่เพิ่มอะไร", async () => {
      const owner = await newMember();
      const bank = await upsertGuest(GROUP_ID, "แบงค์", sql);
      const gift = await upsertGuest(GROUP_ID, "กิ้ฟ", sql);
      await sentBill(owner.user, bank, gift);

      const start = await press(owner.lineUserId, "แก้บิลเดิม", await send(owner.lineUserId, "บอทจ๋า คิดเงิน"));
      await press(owner.lineUserId, "เพิ่มรายการ", start);

      expect(messageTexts(await send(owner.lineUserId, "เดี๋ยวขอดูบิลก่อน"))).toContain("อ่านรายการไม่ออก");
      expect(currentClient.calls).toBe(0);

      // บอกว่าพอแล้ว เลิกแก้ บิลไม่เปลี่ยน
      expect(messageTexts(await send(owner.lineUserId, "พอแล้ว"))).toContain("บิลยังเหมือนเดิม");
      expect(await itemLabels()).toEqual(["ค่าข้าว", "ค่าน้ำ"]);
    });
  });
});

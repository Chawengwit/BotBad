import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isAppError } from "@/errors/app-errors";
import { closeSql, type Sql } from "@/lib/db";
import type { GeminiClient, GeminiTurn } from "@/lib/gemini";
import type { LineMessage } from "@/lib/line";
import { handleEvent } from "@/line/handle-event";
import type { LineEvent } from "@/line/webhook-schema";
import { cancelBill } from "@/repositories/bill.repository";
import { updatePendingPayload, type PendingPayload } from "@/repositories/pending-action.repository";
import { upsertGuest, upsertUser } from "@/repositories/user.repository";
import type { BillRow, LineUserRow, UserRow } from "@/repositories/types";
import { confirmCreateBill, getBill, markPayment, startCreateBill } from "@/services/bill.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { messageTexts } from "../helpers";

const GROUP_ID = "C-test-bill-choice";

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

let currentClient: GeminiClient = fakeClient([]);

// handle-event สร้าง client เองทุกครั้ง จึงต้องดักที่จุดสร้าง ไม่ใช่ส่งเข้าไปทางพารามิเตอร์
vi.mock("@/lib/gemini", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini")>()),
  createGeminiClient: () => currentClient,
}));

/** error ที่ได้จริงพร้อมรายละเอียด ไม่ throw เลยคือ NO_ERROR */
async function failure(run: () => Promise<unknown>): Promise<{ code: string; details: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, details: error.details };
  }
  return { code: "NO_ERROR", details: {} };
}

/**
 * ไม่ระบุชื่อบิล บอทเลือกเฉพาะใบที่คำสั่งนั้นทำได้ (PRP guests-split-bills-and-digest §5.2)
 *
 * ตั้งต้นจากแชทจริงของกลุ่มเมื่อ 2026-09-18: "ค่าข้าวและค่าแบด" ทุกคนจ่ายครบแล้ว ส่วน "ร้านโชคดี" ยังไม่มีใครจ่าย
 * พิมพ์ "วิทจ่ายแล้ว" บอทกลับถามว่าหมายถึงใบไหนในสองใบนี้ ทั้งที่วิทค้างอยู่ใบเดียว
 */
describe.skipIf(!canRunDbTests())("เลือกบิลเมื่อไม่ได้ระบุชื่อ (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];
  let owner: { lineUserId: string; user: LineUserRow };
  let wit: UserRow;
  let hok: UserRow;
  let gift: UserRow;

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM conversation_sessions WHERE line_group_id = ${GROUP_ID}`;
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    // bill_shares, bill_items และ bill_item_payers หลุดตามด้วย ON DELETE CASCADE
    await sql`DELETE FROM bills WHERE line_group_id = ${GROUP_ID}`;
    if (lineUserIds.length > 0) {
      await sql`DELETE FROM users WHERE line_user_id = ANY(${lineUserIds})`;
      lineUserIds.length = 0;
    }
    await sql`DELETE FROM users WHERE line_group_id = ${GROUP_ID}`;
  }

  // สร้าง pool ครั้งเดียวต่อไฟล์ ไม่ใช่ทุกเทส
  beforeAll(() => {
    sql = createTestSql();
  });

  beforeEach(async () => {
    await cleanup();
    currentClient = fakeClient([{ text: "ได้เลยครับ", calls: [] }]);
    vi.stubEnv("GEMINI_API_KEY", "fake-key-value");
    // ชื่อผู้ใช้มาจาก LINE Profile API ระหว่างเทสไม่ยิงเน็ตจริง
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ displayName: "เชวง" }), { status: 200 })),
    );

    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    owner = { lineUserId, user: await upsertUser(lineUserId, "เชวง", sql) };
    wit = await upsertGuest(GROUP_ID, "วิท", sql);
    hok = await upsertGuest(GROUP_ID, "ฮก", sql);
    gift = await upsertGuest(GROUP_ID, "กิ้ฟ", sql);
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

  /** บิลลอย ๆ ที่ส่งแล้ว เชวงเป็นคนสร้าง แต่ละรายการเก็บเฉพาะคนที่ระบุ */
  async function sentBill(
    title: string,
    items: { label: string; amount: number; payers: UserRow[] }[],
  ): Promise<BillRow> {
    const { pending } = await startCreateBill(GROUP_ID, owner.user.id, title);
    await updatePendingPayload(pending.id, {
      court_fee: null,
      shuttle_count: null,
      shuttle_price: null,
      other_items: items.map(({ label, amount }) => ({ label, amount })),
      item_payers: Object.fromEntries(items.map(({ label, payers }) => [label, payers.map((person) => person.id)])),
      extras_done: true,
      promptpay_asked: true,
    } as PendingPayload);
    return (await confirmCreateBill(pending.id, GROUP_ID, owner.user.id)).bill;
  }

  /** สองใบตามแชทจริง: ค่าข้าวและค่าแบดทุกคนจ่ายครบแล้ว ร้านโชคดียังไม่มีใครจ่าย */
  async function chatOfSeptember18(): Promise<void> {
    await sentBill("ค่าข้าวและค่าแบด", [
      { label: "ค่าข้าว", amount: 1200, payers: [wit, hok, gift] },
      { label: "ค่าแบด", amount: 600, payers: [wit, hok] },
      { label: "ค่าน้ำ", amount: 50, payers: [gift, hok] },
    ]);
    await markPayment(GROUP_ID, owner.user, [wit, hok, gift], true, "ค่าข้าวและค่าแบด");

    await sentBill("ร้านโชคดี", [
      { label: "ค่าข้าว", amount: 1500, payers: [wit, hok, gift] },
      { label: "ค่าแบด", amount: 600, payers: [wit, gift] },
      { label: "ค่าน้ำ", amount: 100, payers: [wit, hok] },
    ]);
  }

  /** เชวงพิมพ์ข้อความเข้ากลุ่มเหมือน LINE ส่ง webhook มา คืนข้อความที่บอทตอบ */
  async function send(text: string): Promise<string> {
    const replies: LineMessage[][] = [];
    await handleEvent(
      {
        type: "message",
        replyToken: "reply-token",
        source: { type: "group", groupId: GROUP_ID, userId: owner.lineUserId },
        message: { type: "text", text },
      } as LineEvent,
      {
        accessToken: "test-access-token",
        reply: async (_token, messages) => {
          replies.push(messages);
        },
      },
    );
    return messageTexts(replies[0] ?? []);
  }

  it("วิทค้างแค่ร้านโชคดี บันทึกใบนั้นเลย ไม่ถามถึงใบที่จ่ายครบแล้วหรือใบที่ยกเลิก", async () => {
    await chatOfSeptember18();
    const cancelled = await sentBill("ค่าก๋วยเตี๋ยว", [{ label: "ก๋วยเตี๋ยว", amount: 100, payers: [wit] }]);
    await cancelBill(cancelled.id, sql);

    const result = await markPayment(GROUP_ID, owner.user, [wit], true);

    expect(result.bill.title).toBe("ร้านโชคดี");
    expect(result.people).toEqual([{ user: wit, amountSatang: 85000 }]);
  });

  it("ค้างหลายใบ ถามกลับโดยเสนอเฉพาะใบที่ยังค้าง", async () => {
    await chatOfSeptember18();
    await sentBill("ค่าก๋วยเตี๋ยว", [{ label: "ก๋วยเตี๋ยว", amount: 100, payers: [wit, hok] }]);

    expect(await failure(() => markPayment(GROUP_ID, owner.user, [wit], true))).toEqual({
      code: "BILL_AMBIGUOUS",
      details: { titles: ["ค่าก๋วยเตี๋ยว", "ร้านโชคดี"] },
    });
  });

  it("จ่ายครบทุกใบแล้ว หรือไม่ได้อยู่ในบิลไหนเลย บอกว่าไม่มีบิลค้าง", async () => {
    await chatOfSeptember18();
    await markPayment(GROUP_ID, owner.user, [wit], true, "ร้านโชคดี");
    const bank = await upsertGuest(GROUP_ID, "แบงค์", sql);

    expect(await failure(() => markPayment(GROUP_ID, owner.user, [wit], true))).toEqual({
      code: "NOTHING_OWED",
      details: { names: ["วิท"] },
    });
    expect((await failure(() => markPayment(GROUP_ID, owner.user, [bank], true))).code).toBe("NOTHING_OWED");
  });

  it("ย้อนเป็นยังไม่จ่าย ดูเฉพาะใบที่เคยบันทึกว่าจ่ายแล้ว", async () => {
    await chatOfSeptember18();

    const undone = await markPayment(GROUP_ID, owner.user, [hok], false);
    expect(undone.bill.title).toBe("ค่าข้าวและค่าแบด");
    expect(undone.people.map((entry) => entry.user.display_name)).toEqual(["ฮก"]);

    expect(await failure(() => markPayment(GROUP_ID, owner.user, [hok], false))).toEqual({
      code: "NOTHING_PAID",
      details: { names: ["ฮก"] },
    });
  });

  it("คนที่จ่ายใบนั้นไปแล้ว ไม่ถูกนับว่าเพิ่งจ่ายซ้ำ", async () => {
    await chatOfSeptember18();
    await markPayment(GROUP_ID, owner.user, [wit], true, "ร้านโชคดี");

    // สั่งหลายคนพร้อมกัน เลือกใบจากคนที่ยังค้าง ส่วนวิทที่จ่ายใบนี้ไปแล้วไม่ถูกรวมยอดซ้ำ
    const both = await markPayment(GROUP_ID, owner.user, [wit, hok], true);
    expect(both.bill.title).toBe("ร้านโชคดี");
    expect(both.people).toEqual([{ user: hok, amountSatang: 55000 }]);
    expect(both.unchanged).toEqual([wit]);

    // ระบุชื่อบิลมาเองก็เหมือนกัน
    const again = await markPayment(GROUP_ID, owner.user, [wit], true, "ร้านโชคดี");
    expect(again.people).toEqual([]);
    expect(again.unchanged).toEqual([wit]);
  });

  it("ดูบิลโดยไม่ระบุชื่อ ข้ามใบที่จ่ายครบแล้ว แต่ระบุชื่อมาก็ยังเปิดดูได้", async () => {
    await chatOfSeptember18();
    expect((await getBill(GROUP_ID)).bill.title).toBe("ร้านโชคดี");

    await markPayment(GROUP_ID, owner.user, [wit, hok, gift], true, "ร้านโชคดี");
    expect(await failure(() => getBill(GROUP_ID))).toEqual({
      code: "ALL_BILLS_SETTLED",
      details: { titles: ["ร้านโชคดี", "ค่าข้าวและค่าแบด"] },
    });
    expect((await getBill(GROUP_ID, "ค่าข้าวและค่าแบด")).bill.title).toBe("ค่าข้าวและค่าแบด");
  });

  it("พิมพ์คำสั่งจ่ายแล้ว / ยังไม่จ่าย ได้ผลตามบิลที่คนนั้นเกี่ยวข้อง", async () => {
    await chatOfSeptember18();

    expect(await send("บอทจ๋า จ่ายแล้ว วิท")).toContain("บันทึกแล้ว วิท จ่าย 850.00");
    expect(await send("บอทจ๋า จ่ายแล้ว วิท")).toContain("วิท ไม่มีบิลค้างจ่ายแล้ว");

    // ฮกถูกบันทึกว่าจ่ายแล้วแค่ใบค่าข้าวและค่าแบด
    expect(await send("บอทจ๋า ยังไม่จ่าย ฮก")).toContain("เอา ฮก กลับไปเป็นยังไม่จ่ายแล้ว");
    expect(await send("บอทจ๋า ยังไม่จ่าย ฮก")).toContain("ยังไม่มีบิลไหนที่บันทึกว่า ฮก จ่ายแล้ว");
  });

  it("พิมพ์คำสั่งดูบิล ข้ามใบที่จ่ายครบ ถ้ามีหลายใบขึ้นรายชื่อให้เลือก ไม่ใช่ระบบขัดข้อง", async () => {
    await chatOfSeptember18();

    const unpaid = await send("บอทจ๋า ใครยังไม่จ่าย");
    expect(unpaid).toContain("ร้านโชคดี");
    expect(unpaid).not.toContain("ค่าข้าวและค่าแบด");

    await sentBill("ค่าก๋วยเตี๋ยว", [{ label: "ก๋วยเตี๋ยว", amount: 100, payers: [hok] }]);
    const asked = await send("บอทจ๋า บิล");
    expect(asked).toContain("ค่าก๋วยเตี๋ยว");
    expect(asked).toContain("ร้านโชคดี");
    expect(asked).not.toContain("ค่าข้าวและค่าแบด");

    await markPayment(GROUP_ID, owner.user, [wit, hok, gift], true, "ร้านโชคดี");
    await markPayment(GROUP_ID, owner.user, [hok], true, "ค่าก๋วยเตี๋ยว");
    expect(await send("บอทจ๋า บิล")).toContain("ทุกบิลจ่ายครบแล้ว");
  });

  it("พิมพ์เป็นประโยค LLM เรียก mark_my_payment โดยไม่ระบุบิล ก็บันทึกใบที่วิทค้าง", async () => {
    await chatOfSeptember18();
    currentClient = fakeClient([
      { text: "", calls: [{ name: "mark_my_payment", args: { paid: true, names: ["วิท"] } }] },
      { text: "บันทึกให้แล้วครับ 👍", calls: [] },
    ]);

    const body = await send("บอทจ๋า วิทจ่ายแล้ว");
    expect(body).toContain("บันทึกแล้ว วิท จ่าย 850.00");
    // ผลมาจากระบบอย่างเดียว ข้อความที่ LLM แต่งไม่ขึ้นในแชท
    expect(body).not.toContain("บันทึกให้แล้วครับ");

    const lucky = await getBill(GROUP_ID, "ร้านโชคดี");
    expect(lucky.shares.find((share) => share.user_id === wit.id)?.paid).toBe(true);
  });

  it("พิมพ์เป็นประโยคแล้ววิทค้างหลายใบ ระบบถามเองว่าใบไหน พร้อมคำสั่งที่พิมพ์ต่อได้", async () => {
    await chatOfSeptember18();
    await sentBill("ค่าก๋วยเตี๋ยว", [{ label: "ก๋วยเตี๋ยว", amount: 100, payers: [wit] }]);
    currentClient = fakeClient([
      { text: "", calls: [{ name: "mark_my_payment", args: { paid: true, names: ["วิท"] } }] },
      { text: "บันทึกให้แล้วครับ 👍", calls: [] },
    ]);

    const body = await send("บอทจ๋า วิทจ่ายแล้ว");
    expect(body).toContain("ร้านโชคดี");
    expect(body).toContain('"บอทจ๋า จ่ายแล้ว วิท ค่าก๋วยเตี๋ยว"');
    expect(body).not.toContain("บันทึกให้แล้วครับ");
  });

  it("พิมพ์คำสั่งระบุทั้งคนและบิลได้ ถึงคนนั้นจะค้างหลายใบ", async () => {
    await chatOfSeptember18();
    await sentBill("ค่าก๋วยเตี๋ยว", [{ label: "ก๋วยเตี๋ยว", amount: 100, payers: [wit] }]);

    // ไม่บอกบิล: ถามกลับ ตัวอย่างเป็นคำสั่งเดิมของคนพิมพ์ต่อด้วยชื่อบิล ไม่ใช่คำสั่งดูบิล
    expect(await send("บอทจ๋า จ่ายแล้ว วิท")).toContain('"บอทจ๋า จ่ายแล้ว วิท ค่าก๋วยเตี๋ยว"');

    expect(await send("บอทจ๋า จ่ายแล้ว วิท ร้านโชคดี")).toContain("บันทึกแล้ว วิท จ่าย 850.00");
    const lucky = await getBill(GROUP_ID, "ร้านโชคดี");
    expect(lucky.shares.find((share) => share.user_id === wit.id)?.paid).toBe(true);
  });
});

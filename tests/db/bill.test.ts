import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { isAppError } from "@/errors/app-errors";
import { cancelBill, listActiveBills } from "@/repositories/bill.repository";
import { insertGame, updateGameStatus } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, LineUserRow } from "@/repositories/types";
import { updatePendingPayload, type PendingPayload } from "@/repositories/pending-action.repository";
import {
  confirmCreateBill,
  getBill,
  markPayment,
  startCreateBill,
  summarize,
  type BillDraft,
  type BillView,
} from "@/services/bill.service";
import { joinGame, leaveGame } from "@/services/player.service";
import { handleEvent, type EventContext } from "@/line/handle-event";
import type { LineMessage } from "@/lib/line";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";
import { buttonData, messageTexts } from "../helpers";

const GROUP_ID = "C-test-bill";

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isAppError(error) ? error.code : `NOT_APP_ERROR: ${String(error)}`;
  }
  return "NO_ERROR";
}

type Collected = { messages: LineMessage[] };

function contextFor(collected: Collected[], displayName: string): EventContext {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ displayName }), { status: 200 })),
  );
  return {
    accessToken: "test-access-token",
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

/** หา data ของปุ่มชื่อนี้จากข้อความล่าสุด ไม่เจอถือว่าเทสผิดพลาด */
function actionData(collected: Collected[], label: string): string {
  const data = buttonData(collected.at(-1)?.messages ?? [], label);
  if (data === undefined) throw new Error(`ไม่พบปุ่ม ${label}`);
  return data;
}

describe.skipIf(!canRunDbTests())("คิดเงินค่ารอบตี (ฐานข้อมูลจริง, schema bot_test)", () => {
  let sql: Sql;
  const lineUserIds: string[] = [];

  async function cleanup(): Promise<void> {
    await sql`DELETE FROM pending_actions WHERE line_group_id = ${GROUP_ID}`;
    // ลบผ่าน line_group_id ของบิลโดยตรง บิลลอย ๆ ไม่มี game_id ให้ไล่ตาม
    // bill_shares, bill_items และ bill_item_payers หลุดตามด้วย ON DELETE CASCADE
    await sql`DELETE FROM bills WHERE line_group_id = ${GROUP_ID}`;
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
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name: string): Promise<LineUserRow> {
    const lineUserId = testLineUserId();
    lineUserIds.push(lineUserId);
    return upsertUser(lineUserId, name, sql);
  }

  async function openGame(createdBy: string): Promise<GameRow> {
    return insertGame(
      {
        lineGroupId: GROUP_ID,
        createdBy,
        playDate: "2030-01-15",
        startTime: "19:00",
        durationMinutes: 120,
        courtCount: 1,
        maxPlayers: 8,
        courtName: "คอร์ททดสอบ",
        promptpay: "0812345678",
      },
      sql,
    );
  }

  /** เปิดรอบแล้วให้ทุกคนลงชื่อ คนแรกคือผู้สร้างรอบ */
  async function gameWithPlayers(count: number): Promise<{ owner: LineUserRow; players: LineUserRow[] }> {
    const owner = await newUser("เชวง");
    await openGame(owner.id);

    const players = [owner];
    await joinGame(GROUP_ID, owner.id);
    for (let index = 1; index < count; index += 1) {
      const player = await newUser(`ผู้เล่น ${index}`);
      await joinGame(GROUP_ID, player.id);
      players.push(player);
    }

    return { owner, players };
  }

  /** เดินทางเดียวกับผู้ใช้จริง: เริ่ม wizard แล้วกดยืนยัน */
  async function billFor(owner: LineUserRow, draft: BillDraft): Promise<BillView> {
    const { pending } = await startCreateBill(GROUP_ID, owner.id);
    await updatePendingPayload(pending.id, draft as PendingPayload);
    return confirmCreateBill(pending.id, GROUP_ID, owner.id);
  }

  it("หารเท่ากันทุกคน และยอดรวมของทุกคนเท่ากับยอดบิล", async () => {
    const { owner } = await gameWithPlayers(8);

    const { bill, shares } = await billFor(owner, {
      court_fee: 600,
      shuttle_count: 4,
      shuttle_price: 25,
      other_items: [{ label: "ค่าน้ำ", amount: 60 }],
    });

    expect(bill.total_satang).toBe(76000);
    expect(shares).toHaveLength(8);
    expect(shares.every((share) => share.amount_satang === 9500)).toBe(true);
    expect(shares.reduce((sum, share) => sum + share.amount_satang, 0)).toBe(bill.total_satang);
  });

  it("หารไม่ลงตัว เศษตกที่คนคิดเงิน", async () => {
    const { owner } = await gameWithPlayers(7);

    const { bill, shares } = await billFor(owner, { court_fee: 760 });

    const ownerShare = shares.find((share) => share.user_id === owner.id);
    expect(ownerShare?.amount_satang).toBe(10858);
    expect(shares.filter((s) => s.user_id !== owner.id).every((s) => s.amount_satang === 10857)).toBe(
      true,
    );
    expect(shares.reduce((sum, share) => sum + share.amount_satang, 0)).toBe(bill.total_satang);
  });

  it("คนที่ไม่ได้เปิดรอบ คิดเงินไม่ได้", async () => {
    const { players } = await gameWithPlayers(2);

    expect(await errorCode(() => startCreateBill(GROUP_ID, players[1]!.id))).toBe(
      "NOT_GAME_CREATOR",
    );
  });

  it("ยังไม่มีใครลงชื่อ หารไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.id);

    expect(await errorCode(() => startCreateBill(GROUP_ID, owner.id))).toBe("NO_PLAYERS_TO_SPLIT");
  });

  // เลิกบังคับ 1 รอบ 1 บิลแล้ว รอบหนึ่งมีได้ทั้งค่าคอร์ทและค่ากินข้าว (PRP §5.1)
  it("รอบเดียวมีบิลได้หลายใบ แยกกันด้วยชื่อบิล", async () => {
    const { owner } = await gameWithPlayers(4);
    const first = await billFor(owner, { court_fee: 600 });

    const second = await billFor(owner, { court_fee: 200 });
    expect(second.bill.id).not.toBe(first.bill.id);
    expect(second.bill.title).not.toBe(first.bill.title);
    expect(await sql`SELECT id FROM bills WHERE line_group_id = ${GROUP_ID}`).toHaveLength(2);
  });

  it("ชื่อบิลซ้ำกับใบที่เปิดอยู่ไม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await startCreateBill(GROUP_ID, owner.id, "ค่ากินข้าว");

    // ใบแรกยังไม่ได้ยืนยัน ชื่อจึงยังว่างอยู่ ต้องสร้างจริงก่อนถึงจะชน
    const { pending } = await startCreateBill(GROUP_ID, owner.id, "ค่ากินข้าว 2");
    await updatePendingPayload(pending.id, {
      court_fee: 100,
      shuttle_count: 0,
      shuttle_price: null,
      extras_done: true,
      item_payers: { ค่าคอร์ท: [owner.id] },
    } as PendingPayload);
    await confirmCreateBill(pending.id, GROUP_ID, owner.id);

    expect(await errorCode(() => startCreateBill(GROUP_ID, owner.id, "ค่ากินข้าว 2"))).toBe(
      "BILL_TITLE_TAKEN",
    );
  });

  it("บิลลอย ๆ ไม่ผูกกับรอบ เก็บเฉพาะคนที่ถูกเอ่ยชื่อ", async () => {
    const { owner, players } = await gameWithPlayers(3);
    const { pending } = await startCreateBill(GROUP_ID, owner.id, "ค่ากินข้าว");

    await updatePendingPayload(pending.id, {
      court_fee: null,
      shuttle_count: 0,
      shuttle_price: null,
      other_items: [{ label: "ค่าข้าว", amount: 300 }],
      item_payers: { ค่าข้าว: [owner.id, players[1]!.id] },
      extras_done: true,
    } as PendingPayload);

    const view = await confirmCreateBill(pending.id, GROUP_ID, owner.id);
    expect(view.bill.game_id).toBeNull();
    expect(view.bill.title).toBe("ค่ากินข้าว");
    expect(view.shares).toHaveLength(2);
    expect(view.shares.every((share) => share.amount_satang === 15000)).toBe(true);
  });

  it("แต่ละรายการเก็บคนไม่เท่ากันได้ ยอดรายคนจึงต่างกัน", async () => {
    const { owner, players } = await gameWithPlayers(3);
    const { pending } = await startCreateBill(GROUP_ID, owner.id);

    await updatePendingPayload(pending.id, {
      court_fee: 300,
      shuttle_count: 0,
      shuttle_price: null,
      other_items: [{ label: "ค่าน้ำ", amount: 60 }],
      item_payers: { ค่าน้ำ: [owner.id, players[1]!.id] },
      extras_done: true,
    } as PendingPayload);

    const view = await confirmCreateBill(pending.id, GROUP_ID, owner.id);
    const amountOf = (id: string) =>
      view.shares.find((share) => share.user_id === id)?.amount_satang;

    // ค่าคอร์ทหาร 3 คน ส่วนค่าน้ำหารเฉพาะสองคน
    expect(amountOf(players[2]!.id)).toBe(10000);
    expect(amountOf(players[1]!.id)).toBe(13000);
    expect(view.shares.reduce((sum, share) => sum + share.amount_satang, 0)).toBe(
      view.bill.total_satang,
    );
  });

  it("บอกว่าจ่ายแล้ว กดซ้ำ แล้วย้อนกลับได้ ยอดคงเหลือถูกเสมอ", async () => {
    const { owner, players } = await gameWithPlayers(4);
    await billFor(owner, { court_fee: 400 });

    const first = await markPayment(GROUP_ID, players[1]!, [players[1]!], true);
    expect(first.people.map((entry) => entry.amountSatang)).toEqual([10000]);
    expect(summarize(first.shares).unpaidTotalSatang).toBe(30000);

    // กดซ้ำไม่ใช่ error แค่ไม่มีอะไรเปลี่ยน
    const again = await markPayment(GROUP_ID, players[1]!, [players[1]!], true);
    expect(again.refused).toHaveLength(0);
    expect(summarize(again.shares).unpaidTotalSatang).toBe(30000);

    const undo = await markPayment(GROUP_ID, players[1]!, [players[1]!], false);
    expect(summarize(undo.shares).unpaidTotalSatang).toBe(40000);
  });

  it("จ่ายครบทุกคนถึงจะนับว่าจบ", async () => {
    const { owner, players } = await gameWithPlayers(3);
    await billFor(owner, { court_fee: 300 });

    for (const player of players.slice(0, 2)) {
      await markPayment(GROUP_ID, player, [player], true);
    }
    expect(summarize((await getBill(GROUP_ID)).shares).settled).toBe(false);

    const last = await markPayment(GROUP_ID, players[2]!, [players[2]!], true);
    expect(summarize(last.shares).settled).toBe(true);
  });

  it("คนที่ไม่ได้อยู่ในบิล กดจ่ายไม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 200 });

    // ไม่ throw แล้ว เพราะคำสั่งเดียวกดแทนได้หลายคน คนที่ทำไม่ได้ต้องไม่ล้มทั้งคำสั่ง
    const outsider = await newUser("คนนอก");
    const result = await markPayment(GROUP_ID, outsider, [outsider], true);

    expect(result.people).toHaveLength(0);
    expect(result.refused).toEqual([{ user: outsider, reason: "not_in_bill" }]);
    expect(summarize(result.shares).settled).toBe(false);
  });

  it("ถอนชื่อหลังคิดเงินแล้ว ยอดในบิลไม่เปลี่ยน", async () => {
    const { owner, players } = await gameWithPlayers(4);
    const before = await billFor(owner, { court_fee: 400 });

    await leaveGame(GROUP_ID, players[3]!.id);

    const after = await getBill(GROUP_ID);
    expect(after.shares).toHaveLength(4);
    expect(after.shares.every((share) => share.amount_satang === 10000)).toBe(true);
    expect(after.bill.total_satang).toBe(before.bill.total_satang);
  });

  it("ปิดรอบแล้วบิลยังอยู่ ตามเก็บเงินต่อได้", async () => {
    const { owner, players } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 200 });

    await updateGameStatus(String((await getBill(GROUP_ID)).bill.game_id), "completed", sql);

    const after = await getBill(GROUP_ID);
    expect(after.shares).toHaveLength(2);

    const paid = await markPayment(GROUP_ID, players[1]!, [players[1]!], true);
    expect(paid.people).toHaveLength(1);
  });

  it("ยกเลิกบิลแล้วคิดใหม่ได้", async () => {
    const { owner } = await gameWithPlayers(4);
    const first = await billFor(owner, { court_fee: 400 });

    await cancelBill(first.bill.id, sql);
    expect(await errorCode(() => getBill(GROUP_ID))).toBe("NO_BILL");

    const second = await billFor(owner, { court_fee: 800 });
    expect(second.bill.total_satang).toBe(80000);
    expect((await listActiveBills(GROUP_ID, sql))[0]?.id).toBe(second.bill.id);
  });

  it("เดินครบทั้ง wizard จากคำสั่งจริงจนได้การ์ดบิล", async () => {
    const { owner, players } = await gameWithPlayers(4);
    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า คิดเงิน", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ค่าคอร์ทเท่าไหร่");

    // กดปุ่มค่าคอร์ท แล้วพิมพ์จำนวนลูกกับราคาเอง
    await handleEvent(postbackEvent(actionData(collected, "400"), owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("กี่ลูก");

    await handleEvent(postbackEvent(actionData(collected, "2 ลูก"), owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ลูกละเท่าไหร่");

    // พิมพ์ตอบแบบมีหน่วยปนมา
    await handleEvent(textEvent("25 บาท", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("มีค่าอื่นอีกไหม");

    await handleEvent(postbackEvent(actionData(collected, "ค่าน้ำ"), owner.line_user_id), context);
    await handleEvent(textEvent("50", owner.line_user_id), context);

    await handleEvent(postbackEvent(actionData(collected, "อื่น ๆ"), owner.line_user_id), context);
    await handleEvent(textEvent("ค่าเช่าไม้ 100", owner.line_user_id), context);

    await handleEvent(postbackEvent(actionData(collected, "ไม่มีแล้ว"), owner.line_user_id), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);
    expect(confirmText).toContain("รวม 600.00");
    // การ์ดใหม่ขึ้นยอดรายคนแทน "หาร N คน" เพราะแต่ละรายการเก็บคนไม่เท่ากันได้แล้ว
    expect(confirmText).toContain("600.00");
    expect(confirmText).toContain("150.00");

    await handleEvent(postbackEvent(actionData(collected, "ส่งบิล"), owner.line_user_id), context);
    const cardText = messageTexts(collected.at(-1)!.messages);
    expect(cardText).toContain("คิดเงินแล้ว");
    // การ์ดต้องบอกด้วยว่าโอนให้ใคร ไม่ใช่มีแต่ตัวเลข (PRP §5.2.1)
    expect(cardText).toContain("โอนให้ เชวง");
    expect(cardText).toContain("081-234-5678");
    // การ์ดขึ้นเฉพาะคนที่ยังไม่จ่าย พร้อมยอดที่ยังไม่ได้รับ
    expect(cardText).toContain("ยังไม่จ่าย");
    expect(cardText).toContain("ยังไม่ได้รับ 600.00");

    // 400 + (2 x 25) + 50 + 100 = 600 บาท
    const stored = await getBill(GROUP_ID);
    expect(stored.bill.total_satang).toBe(60000);
    expect(stored.items.map((item) => item.label)).toEqual([
      "ค่าคอร์ท",
      "ลูกแบด",
      "ค่าน้ำ",
      "ค่าเช่าไม้",
    ]);

    // การ์ดบิลไม่มีปุ่มแล้ว (spec §23) คนจ่ายพิมพ์บอกเอง
    const otherContext = contextFor(collected, "ผู้เล่น 1");
    await handleEvent(textEvent("บอทจ๋า จ่ายแล้ว", players[1]!.line_user_id), otherContext);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("เหลืออีก 3 คน");
  });

  it("ค่าคอร์ทข้ามได้ ถ้าเดือนนี้จ่ายเหมาไปแล้ว", async () => {
    const { owner } = await gameWithPlayers(2);
    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า คิดเงิน", owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "ไม่มีค่าคอร์ท"), owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "1 ลูก"), owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "25"), owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "ไม่มีแล้ว"), owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "ส่งบิล"), owner.line_user_id), context);

    const stored = await getBill(GROUP_ID);
    expect(stored.items.map((item) => item.label)).toEqual(["ลูกแบด"]);
    expect(stored.bill.total_satang).toBe(2500);
  });

  it("พิมพ์จำนวนเงินมั่วจะถามใหม่ ไม่เดินหน้าต่อ", async () => {
    const { owner } = await gameWithPlayers(2);
    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า คิดเงิน", owner.line_user_id), context);
    await handleEvent(textEvent("เท่าไหร่ก็ได้", owner.line_user_id), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("พิมพ์เป็นตัวเลข");
    expect(await sql`SELECT id FROM bills WHERE line_group_id = ${GROUP_ID}`).toHaveLength(0);
  });

  it("ยกเลิกบิลผ่านคำสั่งแล้วคิดใหม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 200 });

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ยกเลิกบิล", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ยกเลิกบิลนี้?");

    await handleEvent(postbackEvent(actionData(collected, "ยกเลิกบิล"), owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ยกเลิกบิลแล้ว");

    expect(await errorCode(() => getBill(GROUP_ID))).toBe("NO_BILL");
    expect(await errorCode(() => startCreateBill(GROUP_ID, owner.id))).toBe("NO_ERROR");
  });

  it("ปิดรอบได้แม้ยังจ่ายไม่ครบ แต่ต้องเตือนว่าเหลือใคร", async () => {
    const { owner, players } = await gameWithPlayers(3);
    await billFor(owner, { court_fee: 300 });
    await markPayment(GROUP_ID, players[1]!, [players[1]!], true);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.line_user_id), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);
    expect(confirmText).toContain("ยังมีคนไม่จ่าย 2 คน");
    expect(confirmText).toContain("รวม 200.00");

    await handleEvent(postbackEvent(actionData(collected, "ปิดรอบ"), owner.line_user_id), context);
    const closedText = messageTexts(collected.at(-1)!.messages);
    expect(closedText).toContain("ปิดรอบเรียบร้อย");
    expect(closedText).toContain("ยังค้างอยู่ 2 คน");

    // ปิดรอบแล้วยังตามเก็บต่อได้
    const paid = await markPayment(GROUP_ID, players[2]!, [players[2]!], true);
    expect(paid.people).toHaveLength(1);
  });

  it("ก๊วนที่ไม่ได้คิดเงิน ปิดรอบได้เหมือนเดิม ไม่มีอะไรมาเตือน", async () => {
    const { owner } = await gameWithPlayers(2);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).not.toContain("ยังมีคนไม่จ่าย");

    await handleEvent(postbackEvent(actionData(collected, "ปิดรอบ"), owner.line_user_id), context);
    const closedText = messageTexts(collected.at(-1)!.messages);
    expect(closedText).toContain("ปิดรอบเรียบร้อย");
    expect(closedText).not.toContain("ยังค้างอยู่");
  });

  it("รายการที่บันทึกไว้อ่านกลับมาได้ครบ", async () => {
    const { owner } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 600, shuttle_count: 3, shuttle_price: 25 });

    const stored = await getBill(GROUP_ID);
    // รายการย้ายจาก jsonb มาอยู่ตาราง bill_items แล้ว (PRP §5.1)
    expect(stored.items.map((item) => item.label)).toEqual(["ค่าคอร์ท", "ลูกแบด"]);
    expect(stored.items[1]).toMatchObject({ quantity: 3, unit_price_satang: 2500 });
    expect(stored.items[1]?.payers).toHaveLength(stored.shares.length);
  });
});

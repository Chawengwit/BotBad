import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { isAppError } from "@/errors/app-errors";
import { cancelBill, findActiveBill } from "@/repositories/bill.repository";
import { insertGame, updateGameStatus } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { updatePendingPayload, type PendingPayload } from "@/repositories/pending-action.repository";
import {
  confirmCreateBill,
  getBill,
  markMyPayment,
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
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await cleanup();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await closeSql();
  });

  async function newUser(name: string): Promise<UserRow> {
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
  async function gameWithPlayers(count: number): Promise<{ owner: UserRow; players: UserRow[] }> {
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
  async function billFor(owner: UserRow, draft: BillDraft): Promise<BillView> {
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

  it("รอบเดียวมีบิลได้ใบเดียว", async () => {
    const { owner } = await gameWithPlayers(4);
    await billFor(owner, { court_fee: 600 });

    expect(await errorCode(() => startCreateBill(GROUP_ID, owner.id))).toBe("BILL_ALREADY_EXISTS");
    expect(await sql`SELECT id FROM bills`).toHaveLength(1);
  });

  it("บอกว่าจ่ายแล้ว กดซ้ำ แล้วย้อนกลับได้ ยอดคงเหลือถูกเสมอ", async () => {
    const { owner, players } = await gameWithPlayers(4);
    await billFor(owner, { court_fee: 400 });

    const first = await markMyPayment(GROUP_ID, players[1]!.id, true);
    expect(first.changed).toBe(true);
    expect(first.amountSatang).toBe(10000);
    expect(summarize(first.shares).unpaidTotalSatang).toBe(30000);

    // กดซ้ำไม่ใช่ error แค่ไม่มีอะไรเปลี่ยน
    const again = await markMyPayment(GROUP_ID, players[1]!.id, true);
    expect(again.changed).toBe(false);
    expect(summarize(again.shares).unpaidTotalSatang).toBe(30000);

    const undo = await markMyPayment(GROUP_ID, players[1]!.id, false);
    expect(undo.changed).toBe(true);
    expect(summarize(undo.shares).unpaidTotalSatang).toBe(40000);
  });

  it("จ่ายครบทุกคนถึงจะนับว่าจบ", async () => {
    const { owner, players } = await gameWithPlayers(3);
    await billFor(owner, { court_fee: 300 });

    for (const player of players.slice(0, 2)) {
      await markMyPayment(GROUP_ID, player.id, true);
    }
    expect(summarize((await getBill(GROUP_ID)).shares).settled).toBe(false);

    const last = await markMyPayment(GROUP_ID, players[2]!.id, true);
    expect(summarize(last.shares).settled).toBe(true);
  });

  it("คนที่ไม่ได้อยู่ในบิล กดจ่ายไม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 200 });

    const outsider = await newUser("คนนอก");
    expect(await errorCode(() => markMyPayment(GROUP_ID, outsider.id, true))).toBe("NOT_IN_BILL");
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

    await updateGameStatus((await getBill(GROUP_ID)).bill.game_id, "completed", sql);

    const after = await getBill(GROUP_ID);
    expect(after.shares).toHaveLength(2);

    const paid = await markMyPayment(GROUP_ID, players[1]!.id, true);
    expect(paid.changed).toBe(true);
  });

  it("ยกเลิกบิลแล้วคิดใหม่ได้", async () => {
    const { owner } = await gameWithPlayers(4);
    const first = await billFor(owner, { court_fee: 400 });

    await cancelBill(first.bill.id, sql);
    expect(await errorCode(() => getBill(GROUP_ID))).toBe("NO_BILL");

    const second = await billFor(owner, { court_fee: 800 });
    expect(second.bill.total_satang).toBe(80000);
    expect((await findActiveBill(GROUP_ID, sql))?.id).toBe(second.bill.id);
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

    await handleEvent(postbackEvent(actionData(collected, "💧 ค่าน้ำ"), owner.line_user_id), context);
    await handleEvent(textEvent("50", owner.line_user_id), context);

    await handleEvent(postbackEvent(actionData(collected, "➕ อื่น ๆ"), owner.line_user_id), context);
    await handleEvent(textEvent("ค่าเช่าไม้ 100", owner.line_user_id), context);

    await handleEvent(postbackEvent(actionData(collected, "✅ ไม่มีแล้ว"), owner.line_user_id), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);
    expect(confirmText).toContain("รวม 600.00");
    expect(confirmText).toContain("หาร 4 คน → คนละ 150.00");

    await handleEvent(postbackEvent(actionData(collected, "✅ ส่งบิล"), owner.line_user_id), context);
    const cardText = messageTexts(collected.at(-1)!.messages);
    expect(cardText).toContain("คิดเงินแล้ว");
    expect(cardText).toContain("พร้อมเพย์ 081-234-5678");
    expect(cardText).toContain("ยังไม่จ่าย 4 คน");

    // 400 + (2 x 25) + 50 + 100 = 600 บาท
    const stored = await getBill(GROUP_ID);
    expect(stored.bill.total_satang).toBe(60000);
    expect(stored.bill.items.map((item) => item.label)).toEqual([
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
    await handleEvent(postbackEvent(actionData(collected, "✅ ไม่มีแล้ว"), owner.line_user_id), context);
    await handleEvent(postbackEvent(actionData(collected, "✅ ส่งบิล"), owner.line_user_id), context);

    const stored = await getBill(GROUP_ID);
    expect(stored.bill.items.map((item) => item.label)).toEqual(["ลูกแบด"]);
    expect(stored.bill.total_satang).toBe(2500);
  });

  it("พิมพ์จำนวนเงินมั่วจะถามใหม่ ไม่เดินหน้าต่อ", async () => {
    const { owner } = await gameWithPlayers(2);
    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า คิดเงิน", owner.line_user_id), context);
    await handleEvent(textEvent("เท่าไหร่ก็ได้", owner.line_user_id), context);

    expect(messageTexts(collected.at(-1)!.messages)).toContain("พิมพ์เป็นตัวเลข");
    expect(await sql`SELECT id FROM bills`).toHaveLength(0);
  });

  it("ยกเลิกบิลผ่านคำสั่งแล้วคิดใหม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await billFor(owner, { court_fee: 200 });

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ยกเลิกบิล", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ยกเลิกบิลรอบนี้?");

    await handleEvent(postbackEvent(actionData(collected, "🗑️ ยกเลิกบิล"), owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).toContain("ยกเลิกบิลแล้ว");

    expect(await errorCode(() => getBill(GROUP_ID))).toBe("NO_BILL");
    expect(await errorCode(() => startCreateBill(GROUP_ID, owner.id))).toBe("NO_ERROR");
  });

  it("ปิดรอบได้แม้ยังจ่ายไม่ครบ แต่ต้องเตือนว่าเหลือใคร", async () => {
    const { owner, players } = await gameWithPlayers(3);
    await billFor(owner, { court_fee: 300 });
    await markMyPayment(GROUP_ID, players[1]!.id, true);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.line_user_id), context);
    const confirmText = messageTexts(collected.at(-1)!.messages);
    expect(confirmText).toContain("ยังมีคนไม่จ่าย 2 คน");
    expect(confirmText).toContain("รวม 200.00");

    await handleEvent(postbackEvent(actionData(collected, "✅ ปิดรอบ"), owner.line_user_id), context);
    const closedText = messageTexts(collected.at(-1)!.messages);
    expect(closedText).toContain("ปิดรอบเรียบร้อย");
    expect(closedText).toContain("ยังค้างอยู่ 2 คน");

    // ปิดรอบแล้วยังตามเก็บต่อได้
    const paid = await markMyPayment(GROUP_ID, players[2]!.id, true);
    expect(paid.changed).toBe(true);
  });

  it("ก๊วนที่ไม่ได้คิดเงิน ปิดรอบได้เหมือนเดิม ไม่มีอะไรมาเตือน", async () => {
    const { owner } = await gameWithPlayers(2);

    const collected: Collected[] = [];
    const context = contextFor(collected, "เชวง");

    await handleEvent(textEvent("บอทจ๋า ปิดรอบ", owner.line_user_id), context);
    expect(messageTexts(collected.at(-1)!.messages)).not.toContain("ยังมีคนไม่จ่าย");

    await handleEvent(postbackEvent(actionData(collected, "✅ ปิดรอบ"), owner.line_user_id), context);
    const closedText = messageTexts(collected.at(-1)!.messages);
    expect(closedText).toContain("ปิดรอบเรียบร้อย");
    expect(closedText).not.toContain("ยังค้างอยู่");
  });

  it("รายการที่บันทึกไว้อ่านกลับมาได้ครบ", async () => {
    const { owner } = await gameWithPlayers(2);
    const { bill } = await billFor(owner, {
      court_fee: 600,
      shuttle_count: 3,
      shuttle_price: 25,
    });

    const stored = await getBill(GROUP_ID);
    expect(stored.bill.items).toEqual(bill.items);
    expect(stored.bill.items.map((item) => item.label)).toEqual(["ค่าคอร์ท", "ลูกแบด"]);
    expect(stored.bill.items[1]).toMatchObject({ quantity: 3, unit_price_satang: 2500 });
  });
});

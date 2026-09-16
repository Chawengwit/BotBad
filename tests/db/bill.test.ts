import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSql, type Sql } from "@/lib/db";
import { isAppError } from "@/errors/app-errors";
import { cancelBill, findActiveBill } from "@/repositories/bill.repository";
import { insertGame, updateGameStatus } from "@/repositories/game.repository";
import { upsertUser } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import { createBill, getBill, markMyPayment, summarize } from "@/services/bill.service";
import { joinGame, leaveGame } from "@/services/player.service";
import { canRunDbTests, createTestSql, testLineUserId } from "./helpers";

const GROUP_ID = "C-test-bill";

async function errorCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return isAppError(error) ? error.code : `NOT_APP_ERROR: ${String(error)}`;
  }
  return "NO_ERROR";
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

  afterEach(cleanup);

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

  it("หารเท่ากันทุกคน และยอดรวมของทุกคนเท่ากับยอดบิล", async () => {
    const { owner } = await gameWithPlayers(8);

    const { bill, shares } = await createBill(GROUP_ID, owner.id, {
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

    const { bill, shares } = await createBill(GROUP_ID, owner.id, { court_fee: 760 });

    const ownerShare = shares.find((share) => share.user_id === owner.id);
    expect(ownerShare?.amount_satang).toBe(10858);
    expect(shares.filter((s) => s.user_id !== owner.id).every((s) => s.amount_satang === 10857)).toBe(
      true,
    );
    expect(shares.reduce((sum, share) => sum + share.amount_satang, 0)).toBe(bill.total_satang);
  });

  it("คนที่ไม่ได้เปิดรอบ คิดเงินไม่ได้", async () => {
    const { players } = await gameWithPlayers(2);

    expect(await errorCode(() => createBill(GROUP_ID, players[1]!.id, { court_fee: 600 }))).toBe(
      "NOT_GAME_CREATOR",
    );
  });

  it("ยังไม่มีใครลงชื่อ หารไม่ได้", async () => {
    const owner = await newUser("เชวง");
    await openGame(owner.id);

    expect(await errorCode(() => createBill(GROUP_ID, owner.id, { court_fee: 600 }))).toBe(
      "NO_PLAYERS_TO_SPLIT",
    );
  });

  it("รอบเดียวมีบิลได้ใบเดียว", async () => {
    const { owner } = await gameWithPlayers(4);
    await createBill(GROUP_ID, owner.id, { court_fee: 600 });

    expect(await errorCode(() => createBill(GROUP_ID, owner.id, { court_fee: 700 }))).toBe(
      "BILL_ALREADY_EXISTS",
    );
    expect(await sql`SELECT id FROM bills`).toHaveLength(1);
  });

  it("บอกว่าจ่ายแล้ว กดซ้ำ แล้วย้อนกลับได้ ยอดคงเหลือถูกเสมอ", async () => {
    const { owner, players } = await gameWithPlayers(4);
    await createBill(GROUP_ID, owner.id, { court_fee: 400 });

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
    await createBill(GROUP_ID, owner.id, { court_fee: 300 });

    for (const player of players.slice(0, 2)) {
      await markMyPayment(GROUP_ID, player.id, true);
    }
    expect(summarize((await getBill(GROUP_ID)).shares).settled).toBe(false);

    const last = await markMyPayment(GROUP_ID, players[2]!.id, true);
    expect(summarize(last.shares).settled).toBe(true);
  });

  it("คนที่ไม่ได้อยู่ในบิล กดจ่ายไม่ได้", async () => {
    const { owner } = await gameWithPlayers(2);
    await createBill(GROUP_ID, owner.id, { court_fee: 200 });

    const outsider = await newUser("คนนอก");
    expect(await errorCode(() => markMyPayment(GROUP_ID, outsider.id, true))).toBe("NOT_IN_BILL");
  });

  it("ถอนชื่อหลังคิดเงินแล้ว ยอดในบิลไม่เปลี่ยน", async () => {
    const { owner, players } = await gameWithPlayers(4);
    const before = await createBill(GROUP_ID, owner.id, { court_fee: 400 });

    await leaveGame(GROUP_ID, players[3]!.id);

    const after = await getBill(GROUP_ID);
    expect(after.shares).toHaveLength(4);
    expect(after.shares.every((share) => share.amount_satang === 10000)).toBe(true);
    expect(after.bill.total_satang).toBe(before.bill.total_satang);
  });

  it("ปิดรอบแล้วบิลยังอยู่ ตามเก็บเงินต่อได้", async () => {
    const { owner, players } = await gameWithPlayers(2);
    await createBill(GROUP_ID, owner.id, { court_fee: 200 });

    await updateGameStatus((await getBill(GROUP_ID)).bill.game_id, "completed", sql);

    const after = await getBill(GROUP_ID);
    expect(after.shares).toHaveLength(2);

    const paid = await markMyPayment(GROUP_ID, players[1]!.id, true);
    expect(paid.changed).toBe(true);
  });

  it("ยกเลิกบิลแล้วคิดใหม่ได้", async () => {
    const { owner } = await gameWithPlayers(4);
    const first = await createBill(GROUP_ID, owner.id, { court_fee: 400 });

    await cancelBill(first.bill.id, sql);
    expect(await errorCode(() => getBill(GROUP_ID))).toBe("NO_BILL");

    const second = await createBill(GROUP_ID, owner.id, { court_fee: 800 });
    expect(second.bill.total_satang).toBe(80000);
    expect((await findActiveBill(GROUP_ID, sql))?.id).toBe(second.bill.id);
  });

  it("รายการที่บันทึกไว้อ่านกลับมาได้ครบ", async () => {
    const { owner } = await gameWithPlayers(2);
    const { bill } = await createBill(GROUP_ID, owner.id, {
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

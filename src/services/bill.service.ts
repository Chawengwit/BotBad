import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql } from "@/lib/db";
import {
  findActiveBill,
  findActiveBillByGame,
  insertBill,
  listBillShares,
  markSharePaid,
  type NewBillShare,
} from "@/repositories/bill.repository";
import { findOpenGame } from "@/repositories/game.repository";
import { listJoinedPlayers } from "@/repositories/player.repository";
import type { BillItem, BillRow, BillShareRow, GameRow } from "@/repositories/types";

/**
 * คิดเงินค่ารอบตี (docs/PRP/bill-splitting.md)
 *
 * กติกาที่ทั้งไฟล์นี้ยึด:
 * - เงินเก็บเป็นสตางค์ (integer) เสมอ ห้ามคำนวณเงินด้วยทศนิยม
 * - ทุกรายการหารเท่ากันหมด ไม่มีข้อยกเว้น (สอดคล้อง Full-Time Rule spec §8)
 * - เศษที่หารไม่ลงตัวตกที่คนคิดเงิน เพราะเป็นคนรับโอน
 */

export const MAX_AMOUNT_BAHT = 100_000;
export const MAX_SHUTTLE_COUNT = 50;
export const MAX_OTHER_ITEMS = 5;
export const ITEM_LABEL_MAX_LENGTH = 40;

const bahtSchema = z.number().finite().positive().max(MAX_AMOUNT_BAHT);

export const otherItemSchema = z.object({
  label: z.string().trim().min(1).max(ITEM_LABEL_MAX_LENGTH),
  amount: bahtSchema,
});

export const billDraftSchema = z.object({
  court_fee: bahtSchema.optional(),
  shuttle_count: z.number().int().min(0).max(MAX_SHUTTLE_COUNT).optional(),
  shuttle_price: bahtSchema.optional(),
  other_items: z.array(otherItemSchema).max(MAX_OTHER_ITEMS).optional(),
});

export type BillDraft = z.infer<typeof billDraftSchema>;

/** ผู้ใช้พิมพ์เป็นบาท แต่ระบบคิดเป็นสตางค์ */
export function toSatang(baht: number): number {
  return Math.round(baht * 100);
}

export function toBaht(satang: number): number {
  return satang / 100;
}

/**
 * แปลงสิ่งที่ผู้ใช้ตอบมาเป็นรายการในบิล
 * บิลที่ไม่มีรายการเลย หรือมีลูกแบดแต่ไม่มีราคา ถือว่ายังคิดเงินไม่ได้
 */
export function buildBillItems(draft: BillDraft): BillItem[] {
  const items: BillItem[] = [];

  if (draft.court_fee !== undefined) {
    const amount = toSatang(draft.court_fee);
    items.push({ label: "ค่าคอร์ท", quantity: 1, unit_price_satang: amount, amount_satang: amount });
  }

  const count = draft.shuttle_count ?? 0;
  if (count > 0) {
    if (draft.shuttle_price === undefined) throw new AppError("AMOUNT_INVALID");
    const unit = toSatang(draft.shuttle_price);
    items.push({
      label: "ลูกแบด",
      quantity: count,
      unit_price_satang: unit,
      amount_satang: unit * count,
    });
  }

  for (const item of draft.other_items ?? []) {
    const amount = toSatang(item.amount);
    items.push({ label: item.label, quantity: 1, unit_price_satang: amount, amount_satang: amount });
  }

  if (items.length === 0) throw new AppError("AMOUNT_INVALID");
  return items;
}

export function totalOf(items: BillItem[]): number {
  return items.reduce((sum, item) => sum + item.amount_satang, 0);
}

/**
 * หารเท่ากันทุกคน เศษสตางค์ตกที่คนคิดเงิน
 * ถ้าคนคิดเงินไม่ได้ลงชื่อเล่นด้วย เศษจะตกที่คนแรกที่ลงชื่อแทน
 * (ไม่งั้นเศษจะไม่มีที่ไป และผลรวมของทุกคนจะไม่เท่ากับยอดบิล)
 */
export function splitEqually(
  totalSatang: number,
  payerIds: string[],
  remainderTo: string,
): NewBillShare[] {
  if (payerIds.length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

  const base = Math.floor(totalSatang / payerIds.length);
  const remainder = totalSatang - base * payerIds.length;
  const takesRemainder = payerIds.includes(remainderTo) ? remainderTo : payerIds[0];

  return payerIds.map((userId) => ({
    userId,
    amountSatang: userId === takesRemainder ? base + remainder : base,
  }));
}

export type BillView = {
  game: GameRow;
  bill: BillRow;
  shares: BillShareRow[];
};

export type BillSummary = {
  perPersonSatang: number;
  paid: BillShareRow[];
  unpaid: BillShareRow[];
  unpaidTotalSatang: number;
  settled: boolean;
};

/** "จ่ายครบแล้วหรือยัง" คิดสดจากยอดของแต่ละคนเสมอ ไม่เก็บเป็นสถานะซ้ำ (PRP §5.6) */
export function summarize(shares: BillShareRow[]): BillSummary {
  const paid = shares.filter((share) => share.paid);
  const unpaid = shares.filter((share) => !share.paid);

  return {
    perPersonSatang: shares[0]?.amount_satang ?? 0,
    paid,
    unpaid,
    unpaidTotalSatang: unpaid.reduce((sum, share) => sum + share.amount_satang, 0),
    settled: shares.length > 0 && unpaid.length === 0,
  };
}

/** คิดเงินรอบที่เปิดอยู่ เฉพาะผู้สร้างรอบเท่านั้น (PRP §7) */
export async function createBill(
  lineGroupId: string,
  userId: string,
  draft: BillDraft,
): Promise<BillView> {
  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");
  if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

  const existing = await findActiveBillByGame(game.id);
  if (existing) throw new AppError("BILL_ALREADY_EXISTS");

  const players = await listJoinedPlayers(game.id);
  if (players.length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

  const items = buildBillItems(draft);
  const totalSatang = totalOf(items);
  const shares = splitEqually(
    totalSatang,
    players.map((player) => player.user_id),
    userId,
  );

  const bill = await getSql().begin(async (tx) => {
    // กันคนกดยืนยันการ์ดสองใบพร้อมกัน ให้ unique index ของบิลเป็นคนตัดสิน
    return insertBill({ gameId: game.id, createdBy: userId, items, totalSatang, shares }, tx);
  });

  return { game, bill: bill as BillRow, shares: await listBillShares((bill as BillRow).id) };
}

/** บิลที่ยังใช้งานอยู่ของกลุ่ม พร้อมยอดของทุกคน */
export async function getBill(lineGroupId: string): Promise<BillView & { game: GameRow | null }> {
  const bill = await findActiveBill(lineGroupId);
  if (!bill) throw new AppError("NO_BILL");

  return {
    game: await findOpenGame(lineGroupId),
    bill,
    shares: await listBillShares(bill.id),
  } as BillView & { game: GameRow | null };
}

/**
 * บอกว่าตัวเองจ่ายแล้วหรือยัง
 * บอทเชื่อคำพูดของคนจ่าย ไม่มีขั้นให้ใครมายืนยันอีกที (PRP §4.2)
 */
export async function markMyPayment(
  lineGroupId: string,
  userId: string,
  paid: boolean,
): Promise<{ bill: BillRow; shares: BillShareRow[]; amountSatang: number; changed: boolean }> {
  const bill = await findActiveBill(lineGroupId);
  if (!bill) throw new AppError("NO_BILL");

  const shares = await listBillShares(bill.id);
  const mine = shares.find((share) => share.user_id === userId);
  if (!mine) throw new AppError("NOT_IN_BILL");

  const changed = await markSharePaid(bill.id, userId, paid);

  return {
    bill,
    shares: changed ? await listBillShares(bill.id) : shares,
    amountSatang: mine.amount_satang,
    changed,
  };
}

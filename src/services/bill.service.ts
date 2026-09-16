import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql } from "@/lib/db";
import {
  cancelBill as cancelBillRow,
  findActiveBill,
  findActiveBillByGame,
  insertBill,
  listBillShares,
  markSharePaid,
  type NewBillShare,
} from "@/repositories/bill.repository";
import { findGameById, findOpenGame } from "@/repositories/game.repository";
import {
  consumePendingAction,
  createPendingAction,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
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

/**
 * รอบที่จะคิดเงินได้ ต้องเป็นรอบที่เปิดอยู่ และคนสั่งต้องเป็นคนเปิดรอบ
 * เช็กให้ครบตั้งแต่ก่อนเริ่มถาม จะได้ไม่ให้ตอบไปห้าคำถามแล้วค่อยบอกว่าทำไม่ได้
 */
async function requireBillableGame(lineGroupId: string, userId: string): Promise<GameRow> {
  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");
  if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

  if (await findActiveBillByGame(game.id)) throw new AppError("BILL_ALREADY_EXISTS");
  if ((await listJoinedPlayers(game.id)).length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

  return game;
}

/** เริ่ม wizard คิดเงิน (PRP §7) */
export async function startCreateBill(
  lineGroupId: string,
  userId: string,
): Promise<{ pending: PendingActionRow; game: GameRow }> {
  const game = await requireBillableGame(lineGroupId, userId);

  return {
    game,
    pending: await createPendingAction({
      lineGroupId,
      requestedBy: userId,
      actionType: "create_bill",
      gameId: game.id,
      payload: {},
    }),
  };
}

/**
 * ผู้ใช้พิมพ์จำนวนเงินมาได้หลายแบบ ("600", "600 บาท", "600.50")
 * คืน null เมื่อไม่ใช่จำนวนเงินที่รับได้ ให้ผู้เรียกไปถามใหม่
 */
export function parseAmount(text: string): number | null {
  const digits = text.replace(/[^\d.]/g, "");
  if (digits === "" || (digits.match(/\./g)?.length ?? 0) > 1) return null;

  const parsed = bahtSchema.safeParse(Number(digits));
  return parsed.success ? parsed.data : null;
}

/** รายการอื่น ๆ พิมพ์มาบรรทัดเดียว เช่น "ค่าเช่าไม้ 100" */
export function parseOtherItem(text: string): { label: string; amount: number } | null {
  const match = text.trim().match(/^(.*?)[\s:]*([\d.,]+)\s*(?:บาท)?$/);
  if (!match) return null;

  const amount = parseAmount(match[2] ?? "");
  if (amount === null) return null;

  const parsed = otherItemSchema.safeParse({ label: match[1] ?? "", amount });
  return parsed.success ? parsed.data : null;
}

/** แปลง payload ที่ wizard สะสมไว้เป็นร่างบิล */
export function draftFromPayload(payload: Record<string, unknown>): BillDraft {
  const parsed = billDraftSchema.safeParse({
    // ข้ามข้อไหนไป wizard จะเก็บเป็น null ซึ่งแปลว่า "ไม่มีรายการนี้"
    court_fee: payload.court_fee ?? undefined,
    shuttle_count: payload.shuttle_count ?? undefined,
    shuttle_price: payload.shuttle_price ?? undefined,
    other_items: payload.other_items ?? undefined,
  });
  if (!parsed.success) throw new AppError("AMOUNT_INVALID");

  return parsed.data;
}

/**
 * ยืนยันส่งบิล ทำในทรานแซกชันเดียว: ใช้ pending action + สร้างบิล + ตัดยอดของทุกคน
 * ถ้าล้มกลางทางต้องไม่เหลือบิลที่ไม่มียอดของใครเลย
 */
export async function confirmCreateBill(
  pendingId: string,
  lineGroupId: string,
  userId: string,
): Promise<BillView> {
  const created = await getSql().begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending || pending.action_type !== "create_bill") throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

    const game = await findOpenGame(lineGroupId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");
    // การ์ดใบนี้ออกไว้กับรอบไหน ต้องคิดเงินให้รอบนั้นเท่านั้น
    if (pending.game_id && pending.game_id !== game.id) throw new AppError("PENDING_EXPIRED");
    if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");
    if (await findActiveBillByGame(game.id, tx)) throw new AppError("BILL_ALREADY_EXISTS");

    const players = await listJoinedPlayers(game.id, tx);
    if (players.length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

    const items = buildBillItems(draftFromPayload(pending.payload));
    const totalSatang = totalOf(items);
    const shares = splitEqually(
      totalSatang,
      players.map((player) => player.user_id),
      userId,
    );

    const bill = await insertBill(
      { gameId: game.id, createdBy: userId, items, totalSatang, shares },
      tx,
    );

    return { game, bill };
  });

  const { game, bill } = created as { game: GameRow; bill: BillRow };
  return { game, bill, shares: await listBillShares(bill.id) };
}

/** สรุปบิลสั้น ๆ สำหรับใส่ใน system prompt คืน null เมื่อกลุ่มยังไม่มีบิล */
export async function findBillContext(
  lineGroupId: string,
  userId: string,
): Promise<{
  perPersonBaht: number;
  unpaidCount: number;
  settled: boolean;
  requesterPaid: boolean | null;
} | null> {
  const bill = await findActiveBill(lineGroupId);
  if (!bill) return null;

  const shares = await listBillShares(bill.id);
  const { unpaid, settled } = summarize(shares);

  return {
    perPersonBaht: toBaht(shares[0]?.amount_satang ?? 0),
    unpaidCount: unpaid.length,
    settled,
    requesterPaid: shares.find((share) => share.user_id === userId)?.paid ?? null,
  };
}

/**
 * คนที่ยังไม่จ่ายของรอบนั้น ใช้เตือนตอนปิดรอบหรือยกเลิกรอบ
 * ไม่มีบิลก็ไม่มีอะไรต้องเตือน ก๊วนที่ไม่ใช้ฟีเจอร์คิดเงินต้องไม่รู้สึกอะไรเลย (PRP §5.7)
 */
export async function unpaidSharesForGame(gameId: string): Promise<BillShareRow[]> {
  const bill = await findActiveBillByGame(gameId);
  if (!bill) return [];

  return (await listBillShares(bill.id)).filter((share) => !share.paid);
}

/** ขอยกเลิกบิล เฉพาะคนที่คิดเงิน (= คนเปิดรอบ) */
export async function startCancelBill(
  lineGroupId: string,
  userId: string,
): Promise<{ pending: PendingActionRow; view: BillView }> {
  const view = await getBill(lineGroupId);
  if (view.bill.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

  return {
    view,
    pending: await createPendingAction({
      lineGroupId,
      requestedBy: userId,
      actionType: "cancel_bill",
      gameId: view.bill.game_id,
      payload: { bill_id: view.bill.id },
    }),
  };
}

export async function confirmCancelBill(
  pendingId: string,
  lineGroupId: string,
  userId: string,
): Promise<void> {
  await getSql().begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending || pending.action_type !== "cancel_bill") throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

    const bill = await findActiveBill(lineGroupId, tx);
    if (!bill || bill.id !== pending.payload.bill_id) throw new AppError("NO_BILL");
    if (bill.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

    await cancelBillRow(bill.id, tx);
  });
}

/**
 * บิลที่ยังใช้งานอยู่ของกลุ่ม พร้อมยอดของทุกคน
 * อ่านรอบจาก game_id ของบิลโดยตรง เพราะรอบอาจปิดไปแล้วแต่ยังตามเก็บเงินกันอยู่ (PRP §5.4)
 */
export async function getBill(lineGroupId: string): Promise<BillView> {
  const bill = await findActiveBill(lineGroupId);
  if (!bill) throw new AppError("NO_BILL");

  const game = await findGameById(bill.game_id);
  if (!game) throw new AppError("NO_BILL");

  return { game, bill, shares: await listBillShares(bill.id) };
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

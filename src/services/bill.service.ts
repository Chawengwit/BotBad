import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql } from "@/lib/db";
import {
  cancelBill as cancelBillRow,
  findActiveBillByTitle,
  findBillById,
  insertBill,
  listActiveBills,
  listActiveBillsByGame,
  listBillItems,
  listBillShares,
  markSharePaid,
  type NewBillItem,
  type NewBillShare,
} from "@/repositories/bill.repository";
import { findGameById, findOpenGame } from "@/repositories/game.repository";
import {
  consumePendingAction,
  createPendingAction,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import { findAddedBy, listJoinedPlayers } from "@/repositories/player.repository";
import { formatThaiDate } from "@/lib/time";
import { parseNames } from "./people.service";
import type { BillItem, BillItemRow, BillRow, BillShareRow, GameRow, UserRow } from "@/repositories/types";

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
 * ถ้าคนคิดเงินไม่ได้ร่วมจ่ายรายการนั้น เศษจะตกที่คนแรกของรายการแทน
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

/**
 * หารทีละรายการ ไม่ใช่หารยอดรวม (PRP guests-split-bills-and-digest §5.5)
 *
 * ยอดของคน X = ผลรวมของ (รายการ ÷ จำนวนคนร่วมจ่ายของรายการนั้น) ทุกรายการที่ X ร่วมจ่าย
 * เศษของแต่ละรายการคิดแยกกัน จะได้ตรวจย้อนกลับได้ว่าเศษไปอยู่ที่ใครของรายการไหน
 */
export function splitByItem(
  items: { item: BillItem; payerIds: string[] }[],
  remainderTo: string,
): { items: NewBillItem[]; shares: NewBillShare[]; totalSatang: number } {
  if (items.length === 0) throw new AppError("AMOUNT_INVALID");

  const perPerson = new Map<string, number>();
  const built: NewBillItem[] = [];

  for (const { item, payerIds } of items) {
    if (payerIds.length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

    const payers = splitEqually(item.amount_satang, payerIds, remainderTo);
    for (const payer of payers) {
      perPerson.set(payer.userId, (perPerson.get(payer.userId) ?? 0) + payer.amountSatang);
    }

    built.push({
      label: item.label,
      quantity: item.quantity,
      unitPriceSatang: item.unit_price_satang,
      amountSatang: item.amount_satang,
      payers,
    });
  }

  return {
    items: built,
    shares: [...perPerson].map(([userId, amountSatang]) => ({ userId, amountSatang })),
    totalSatang: built.reduce((sum, item) => sum + item.amountSatang, 0),
  };
}

export type BillView = {
  bill: BillRow;
  /** null = บิลลอย ๆ ที่ไม่ผูกกับรอบตี */
  game: GameRow | null;
  items: BillItemRow[];
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
  if ((await listJoinedPlayers(game.id)).length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

  return game;
}

/** ชื่อบิลตั้งต้นของรอบตี ถ้าชนกับใบที่เปิดอยู่จะเติมลำดับต่อท้าย */
async function defaultBillTitle(lineGroupId: string, game: GameRow): Promise<string> {
  const base = `รอบ ${formatThaiDate(game.play_date)}`;
  const taken = new Set((await listActiveBills(lineGroupId)).map((bill) => bill.title));

  if (!taken.has(base)) return base;
  for (let index = 2; index <= 20; index += 1) {
    if (!taken.has(`${base} (${index})`)) return `${base} (${index})`;
  }
  throw new AppError("BILL_TITLE_TAKEN", { title: base });
}

/**
 * เริ่ม wizard คิดเงิน (PRP guests-split-bills-and-digest §5)
 *
 * ระบุชื่อบิลมา = บิลลอย ๆ ที่ไม่ผูกกับรอบตี ใครในกลุ่มก็สร้างได้
 * ไม่ระบุ = บิลของรอบที่เปิดอยู่ เฉพาะคนเปิดรอบเท่านั้น
 */
export async function startCreateBill(
  lineGroupId: string,
  userId: string,
  title = "",
): Promise<{ pending: PendingActionRow; game: GameRow | null; title: string }> {
  const wanted = title.trim();

  if (wanted) {
    if (await findActiveBillByTitle(lineGroupId, wanted)) {
      throw new AppError("BILL_TITLE_TAKEN", { title: wanted });
    }

    return {
      game: null,
      title: wanted,
      pending: await createPendingAction({
        lineGroupId,
        requestedBy: userId,
        actionType: "create_bill",
        payload: { title: wanted },
      }),
    };
  }

  const game = await requireBillableGame(lineGroupId, userId);
  const autoTitle = await defaultBillTitle(lineGroupId, game);

  return {
    game,
    title: autoTitle,
    pending: await createPendingAction({
      lineGroupId,
      requestedBy: userId,
      actionType: "create_bill",
      gameId: game.id,
      payload: { title: autoTitle },
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

export type ParsedItemLine = { label: string; amount: number; payerNames: string[] };

/**
 * รายการพิมพ์มาบรรทัดเดียว `<ชื่อรายการ> <จำนวนเงิน> [ชื่อคน ...]`
 * (PRP guests-split-bills-and-digest §5.3)
 *
 *   ค่าเช่าไม้ 100              → เก็บทุกคนในบิล
 *   ค่าน้ำ 60 เชวง แบงค์        → เก็บสองคนนี้
 *
 * จำนวนเงินเป็นตัวคั่นระหว่างชื่อรายการกับรายชื่อคน จึงไม่ต้องเดาว่าคำไหนเป็นชื่อใคร
 */
export function parseItemLine(text: string): ParsedItemLine | null {
  const match = text.trim().match(/^(.*?)[\s:]*([\d.,]+)\s*(?:บาท)?(?:\s+(.*))?$/u);
  if (!match) return null;

  const amount = parseAmount(match[2] ?? "");
  if (amount === null) return null;

  const parsed = otherItemSchema.safeParse({ label: match[1] ?? "", amount });
  if (!parsed.success) return null;

  return { ...parsed.data, payerNames: parseNames(match[3] ?? "") };
}

/** รายการอื่น ๆ แบบไม่สนใจว่าใครร่วมจ่าย ใช้ในที่ที่ยังไม่รองรับการเลือกคน */
export function parseOtherItem(text: string): { label: string; amount: number } | null {
  const parsed = parseItemLine(text);
  return parsed ? { label: parsed.label, amount: parsed.amount } : null;
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
 * ยืนยันส่งบิล ทำในทรานแซกชันเดียว: ใช้ pending action + สร้างบิล + รายการ + ยอดของทุกคน
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

    const title = String(pending.payload.title ?? "").trim();
    if (!title) throw new AppError("PENDING_EXPIRED");
    if (await findActiveBillByTitle(lineGroupId, title, tx)) {
      throw new AppError("BILL_TITLE_TAKEN", { title });
    }

    const game = pending.game_id ? await findGameById(pending.game_id, tx) : null;
    if (pending.game_id && !game) throw new AppError("PENDING_EXPIRED");
    if (game && game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

    // คนที่อยู่ในบิลตั้งต้น: รอบตีใช้คนที่ลงชื่อ ส่วนบิลลอย ๆ ใช้คนที่ถูกเอ่ยชื่อในรายการ
    const defaultPayerIds = game
      ? (await listJoinedPlayers(game.id, tx)).map((player) => player.user_id)
      : [];

    const draft = draftFromPayload(pending.payload);
    const items = buildBillItems(draft);
    const payersByLabel = (pending.payload.item_payers ?? {}) as Record<string, string[]>;
    const withPayers = attachPayers(items, payersByLabel, defaultPayerIds);

    const split = splitByItem(withPayers, userId);
    const bill = await insertBill(
      {
        lineGroupId,
        gameId: game?.id ?? null,
        createdBy: userId,
        title,
        promptpay: (pending.payload.promptpay as string | undefined) ?? game?.promptpay ?? null,
        items: split.items,
        totalSatang: split.totalSatang,
        shares: split.shares,
      },
      tx,
    );

    return { game, bill };
  });

  const { game, bill } = created as { game: GameRow | null; bill: BillRow };
  return {
    game,
    bill,
    items: await listBillItems(bill.id),
    shares: await listBillShares(bill.id),
  };
}

/**
 * ผูกคนร่วมจ่ายเข้ากับแต่ละรายการ
 * รายการที่ไม่ได้ระบุชื่อใครไว้ = เก็บทุกคนในบิล
 * บิลลอย ๆ ไม่มีรอบให้ดึงรายชื่อ คนในบิลจึงเป็นสหภาพของทุกคนที่ถูกเอ่ยชื่อในรายการ
 */
export function attachPayers(
  items: BillItem[],
  payersByLabel: Record<string, string[]>,
  defaultPayerIds: string[],
): { item: BillItem; payerIds: string[] }[] {
  const everyone =
    defaultPayerIds.length > 0
      ? defaultPayerIds
      : [...new Set(Object.values(payersByLabel).flat())];

  return items.map((item) => {
    const chosen = payersByLabel[item.label];
    const payerIds = chosen && chosen.length > 0 ? chosen : everyone;
    if (payerIds.length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");
    return { item, payerIds };
  });
}

/**
 * เลือกบิลที่คำสั่งนี้หมายถึง (PRP guests-split-bills-and-digest §5.2)
 * กลุ่มมีบิลเปิดพร้อมกันได้หลายใบ ไม่ระบุชื่อตอนมีหลายใบจึงต้องถามกลับ
 */
export async function resolveBill(lineGroupId: string, title = ""): Promise<BillRow> {
  const wanted = title.trim();

  if (wanted) {
    const found = await findActiveBillByTitle(lineGroupId, wanted);
    if (!found) throw new AppError("NO_BILL", { title: wanted });
    return found;
  }

  const bills = await listActiveBills(lineGroupId);
  if (bills.length === 0) throw new AppError("NO_BILL");
  if (bills.length > 1) {
    throw new AppError("BILL_AMBIGUOUS", { titles: bills.map((bill) => bill.title) });
  }
  return bills[0]!;
}

/**
 * บิลพร้อมรายการและยอดของทุกคน
 * อ่านรอบจาก game_id ของบิลโดยตรง เพราะรอบอาจปิดไปแล้วแต่ยังตามเก็บเงินกันอยู่
 * บิลลอย ๆ ไม่มีรอบเลย ซึ่งไม่ใช่ error
 */
export async function getBill(lineGroupId: string, title = ""): Promise<BillView> {
  const bill = await resolveBill(lineGroupId, title);

  return {
    bill,
    game: bill.game_id ? await findGameById(bill.game_id) : null,
    items: await listBillItems(bill.id),
    shares: await listBillShares(bill.id),
  };
}

/** สรุปบิลสั้น ๆ สำหรับใส่ใน system prompt คืน null เมื่อกลุ่มยังไม่มีบิล */
export async function findBillContext(
  lineGroupId: string,
  userId: string,
): Promise<{
  title: string;
  openBillCount: number;
  myAmountBaht: number | null;
  unpaidCount: number;
  settled: boolean;
  requesterPaid: boolean | null;
} | null> {
  const bills = await listActiveBills(lineGroupId);
  const bill = bills[0];
  if (!bill) return null;

  const shares = await listBillShares(bill.id);
  const { unpaid, settled } = summarize(shares);
  const mine = shares.find((share) => share.user_id === userId);

  return {
    title: bill.title,
    openBillCount: bills.length,
    myAmountBaht: mine ? toBaht(mine.amount_satang) : null,
    unpaidCount: unpaid.length,
    settled,
    requesterPaid: mine?.paid ?? null,
  };
}

/**
 * คนที่ยังไม่จ่ายของรอบนั้น ใช้เตือนตอนปิดรอบหรือยกเลิกรอบ
 * รอบหนึ่งมีบิลได้หลายใบแล้ว จึงรวมคนค้างของทุกใบ
 * ไม่มีบิลก็ไม่มีอะไรต้องเตือน ก๊วนที่ไม่ใช้ฟีเจอร์คิดเงินต้องไม่รู้สึกอะไรเลย
 */
export async function unpaidSharesForGame(gameId: string): Promise<BillShareRow[]> {
  const bills = await listActiveBillsByGame(gameId);
  const perBill = await Promise.all(bills.map((bill) => listBillShares(bill.id)));

  return perBill.flat().filter((share) => !share.paid);
}

/** ขอยกเลิกบิล เฉพาะคนที่สร้างบิลใบนั้น */
export async function startCancelBill(
  lineGroupId: string,
  userId: string,
  title = "",
): Promise<{ pending: PendingActionRow; view: BillView }> {
  const view = await getBill(lineGroupId, title);
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

    const billId = String(pending.payload.bill_id ?? "");
    const bill = await findBillById(billId, tx);
    if (!bill || bill.status !== "sent" || bill.line_group_id !== lineGroupId) {
      throw new AppError("NO_BILL");
    }
    if (bill.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

    await cancelBillRow(bill.id, tx);
  });
}

export type PaymentResult = {
  bill: BillRow;
  shares: BillShareRow[];
  /** คนที่บันทึกสำเร็จ */
  people: { user: UserRow; amountSatang: number }[];
  /** คนที่ทำไม่ได้ เพราะไม่อยู่ในบิลหรือไม่มีสิทธิ์กดแทน */
  refused: { user: UserRow; reason: "not_in_bill" | "not_allowed" }[];
};

/**
 * บันทึกว่าจ่ายแล้วหรือยัง ของตัวเองหรือของคนอื่นก็ได้ (PRP §5.6)
 *
 * กดแทนได้เมื่อเป็นเจ้าตัว เป็นคนที่พาคนนั้นมาในรอบของบิลนี้ หรือเป็นคนสร้างบิล
 * คนสร้างบิลได้สิทธิ์เพราะเป็นคนรับโอน มีคนจ่ายเงินสดให้ตรง ๆ ได้
 * บอทเชื่อคำพูดของคนจ่าย ไม่มีขั้นให้ใครมายืนยันอีกที
 */
export async function markPayment(
  lineGroupId: string,
  actor: UserRow,
  people: UserRow[],
  paid: boolean,
  title = "",
): Promise<PaymentResult> {
  const bill = await resolveBill(lineGroupId, title);
  const before = await listBillShares(bill.id);
  const result: PaymentResult = { bill, shares: before, people: [], refused: [] };

  for (const person of people) {
    const share = before.find((row) => row.user_id === person.id);
    if (!share) {
      result.refused.push({ user: person, reason: "not_in_bill" });
      continue;
    }

    const isSelf = person.id === actor.id;
    const isBillOwner = bill.created_by === actor.id;
    const broughtThem =
      bill.game_id !== null && (await findAddedBy(bill.game_id, person.id)) === actor.id;

    if (!isSelf && !isBillOwner && !broughtThem) {
      result.refused.push({ user: person, reason: "not_allowed" });
      continue;
    }

    await markSharePaid(bill.id, person.id, paid, paid ? actor.id : null);
    result.people.push({ user: person, amountSatang: share.amount_satang });
  }

  result.shares = result.people.length > 0 ? await listBillShares(bill.id) : before;
  return result;
}

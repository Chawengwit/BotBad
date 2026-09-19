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
  listActiveBillsWithPayers,
  listBillItems,
  listBillShares,
  listEditableBills,
  markSharePaid,
  replaceBillItems,
  syncBillShares,
  type ActiveBill,
  type NewBillItem,
  type NewBillShare,
} from "@/repositories/bill.repository";
import { findGameById, listBillableGames } from "@/repositories/game.repository";
import {
  consumePendingAction,
  createPendingAction,
  findUsablePendingAction,
  updatePendingPayload,
  type PendingActionRow,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import { findAddedBy, listJoinedPlayers } from "@/repositories/player.repository";
import { formatThaiDate } from "@/lib/time";
import { parseNames } from "./people.service";
import { loadRounds, type Round } from "./round.service";
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
 * เกมที่ยังคิดค่ารอบได้ พร้อมรายชื่อ: ยังเปิดอยู่ หรือปิดไปไม่เกิน 7 วัน (PRP multi-open-rounds §5.1)
 * การปิดเกมไม่ขวางการคิดเงินอีกต่อไป ทั้งปิดเองและปิดอัตโนมัติ
 */
export async function loadBillableRounds(lineGroupId: string): Promise<Round[]> {
  return loadRounds(await listBillableGames(lineGroupId));
}

/** คิดค่ารอบได้เฉพาะคนเปิดรอบ และต้องมีคนลงชื่อให้หาร */
export function canBillRound(round: Round, userId: string): boolean {
  return round.game.created_by === userId && round.players.length > 0;
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
 * บิลลอย ๆ ที่ไม่ผูกกับรอบตี ใครในกลุ่มก็สร้างได้ (PRP guests-split-bills-and-digest §5)
 * ชื่อต้องไม่ซ้ำกับบิลที่ยังเปิดอยู่ของกลุ่ม ส่วนบิลค่ารอบใช้ startGameBill
 */
export async function startCreateBill(
  lineGroupId: string,
  userId: string,
  title: string,
): Promise<{ pending: PendingActionRow; title: string }> {
  const wanted = title.trim();
  await requireFreeTitle(lineGroupId, wanted);

  return {
    title: wanted,
    pending: await createPendingAction({
      lineGroupId,
      requestedBy: userId,
      actionType: "create_bill",
      payload: { title: wanted },
    }),
  };
}

/**
 * บิลค่ารอบของเกมที่เลือก ชื่อตั้งให้เอง
 * เช็กให้ครบตั้งแต่ก่อนเริ่มถาม จะได้ไม่ให้ตอบไปห้าคำถามแล้วค่อยบอกว่าทำไม่ได้
 */
export async function startGameBill(
  lineGroupId: string,
  userId: string,
  gameId: string,
): Promise<{ pending: PendingActionRow; game: GameRow; title: string }> {
  const game = (await listBillableGames(lineGroupId)).find((candidate) => candidate.id === gameId);
  if (!game) throw new AppError("NO_OPEN_GAME");
  if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");
  if ((await listJoinedPlayers(game.id)).length === 0) throw new AppError("NO_PLAYERS_TO_SPLIT");

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

export async function requireFreeTitle(lineGroupId: string, title: string): Promise<void> {
  if (await findActiveBillByTitle(lineGroupId, title)) {
    throw new AppError("BILL_TITLE_TAKEN", { title });
  }
}

/** ทำไมคิดค่ารอบไม่ได้ ทั้งที่มีเกมที่ยังคิดค่ารอบได้อยู่ */
export type GameBillBlock = "not_creator" | "no_players";

export type BillMenuOptions = {
  /** เกมที่คนนี้คิดค่ารอบได้ตอนนี้ ว่าง = ไม่มีปุ่มคิดค่ารอบ */
  games: GameRow[];
  /** มีเกมอยู่แต่คิดค่ารอบไม่ได้ บอกเหตุผลใต้คำถาม ไม่ใช่ให้ปุ่มหายไปเฉย ๆ */
  gameBlocked: { game: GameRow; reason: GameBillBlock } | null;
  /** บิลที่คนนี้แก้ได้ (เขาสร้างเอง) */
  editableBills: BillRow[];
};

/**
 * "คิดเงิน" เฉย ๆ ไม่บอกว่าเงินเรื่องไหน ถามก่อนทุกครั้งแทนการเดาว่าเป็นค่ารอบ
 * เพราะหลังตีเสร็จคนก็คิดค่ากินข้าวกันด้วย ถ้าเดาผิดต้องตอบค่าคอร์ทไปห้าคำถามถึงจะรู้ตัว
 */
export async function billMenuOptions(lineGroupId: string, userId: string): Promise<BillMenuOptions> {
  const [rounds, editableBills] = await Promise.all([
    loadBillableRounds(lineGroupId),
    listEditableBills(lineGroupId, userId),
  ]);

  const games = rounds.filter((round) => canBillRound(round, userId)).map((round) => round.game);
  if (games.length > 0) return { games, gameBlocked: null, editableBills };

  const mine = rounds.find((round) => round.game.created_by === userId);
  if (mine) return { games, gameBlocked: { game: mine.game, reason: "no_players" }, editableBills };

  const other = rounds[0];
  return { games, gameBlocked: other ? { game: other.game, reason: "not_creator" } : null, editableBills };
}

/**
 * เริ่มบิลใหม่ที่ไม่ผูกกับรอบ ให้พิมพ์ชื่อบิลกับรายการมาอิสระแล้วให้ Gemini แปลง
 *
 * awaiting ทำให้ข้อความถัดไปของคนนี้มาที่บิลใบนี้ก่อนอย่างอื่น
 * ไม่งั้น "บิล ร้านโชคดี ..." จะหลุดไปเป็นคำสั่งดูบิล
 */
export async function startNewBill(
  lineGroupId: string,
  userId: string,
  title = "",
): Promise<PendingActionRow> {
  const wanted = title.trim();
  if (wanted) await requireFreeTitle(lineGroupId, wanted);

  return createPendingAction({
    lineGroupId,
    requestedBy: userId,
    actionType: "create_bill",
    payload: { ...(wanted ? { title: wanted } : {}), awaiting: "bill_freeform" },
  });
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

/** หัวข้อย่อยที่คนชอบพิมพ์นำหน้ารายการ เช่น "- ค่าข้าว 1500" หรือ "1. ค่าน้ำ 100" */
const ITEM_BULLET = /^\s*(?:[-*•·]\s*|\d+[.)]\s+)/u;

/** คำที่คนพิมพ์คั่นก่อนรายชื่อ เช่น "ค่าข้าว 1500 คิด วิท ฮก" ไม่ใช่ชื่อคน ถ้าเก็บไว้จะได้แขกชื่อ "คิด" */
const PAYER_LEAD_WORD = /^(?:คิด|หาร|เก็บ)(?:\s+|$)/u;

/**
 * รายการพิมพ์มาบรรทัดเดียว `<ชื่อรายการ> <จำนวนเงิน> [ชื่อคน ...]`
 * (PRP guests-split-bills-and-digest §5.3)
 *
 *   ค่าเช่าไม้ 100              → เก็บทุกคนในบิล
 *   ค่าน้ำ 60 เชวง แบงค์        → เก็บสองคนนี้
 *   - ค่าข้าว 1500 คิด วิท ฮก   → ตัด "-" กับ "คิด" ออก เก็บวิทกับฮก
 *
 * จำนวนเงินเป็นตัวคั่นระหว่างชื่อรายการกับรายชื่อคน จึงไม่ต้องเดาว่าคำไหนเป็นชื่อใคร
 */
export function parseItemLine(text: string): ParsedItemLine | null {
  const line = text.trim().replace(ITEM_BULLET, "");
  const match = line.match(/^(.*?)[\s:]*([\d.,]+)\s*(?:บาท)?(?:\s+(.*))?$/u);
  if (!match) return null;

  const amount = parseAmount(match[2] ?? "");
  if (amount === null) return null;

  const parsed = otherItemSchema.safeParse({ label: match[1] ?? "", amount });
  if (!parsed.success) return null;

  const names = (match[3] ?? "").trim().replace(PAYER_LEAD_WORD, "");
  return { ...parsed.data, payerNames: parseNames(names) };
}

/**
 * หลายรายการในข้อความเดียว บรรทัดละรายการ บรรทัดว่างข้ามไป
 * คืน null ถ้ามีบรรทัดไหนอ่านไม่ออก จะได้ไม่เพิ่มแค่บางรายการแล้วคนพิมพ์ไม่รู้ตัว
 */
export function parseItemLines(text: string): ParsedItemLine[] | null {
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  const parsed = lines.map(parseItemLine);
  return parsed.every((item) => item !== null) ? (parsed as ParsedItemLine[]) : null;
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
 *
 * ระบุชื่อมา = ใบนั้นเสมอ แม้ทุกคนจะจ่ายครบแล้วก็ตาม
 * ไม่ระบุ = เลือกเฉพาะใบที่เปิดอยู่และคำสั่งนี้ทำได้ (fits) เช่น "จ่ายแล้ว" ดูเฉพาะใบที่คนนั้นยังค้าง
 * จะได้ไม่ถามถึงใบที่เขาจ่ายไปแล้ว เหลือใบเดียวใช้เลย หลายใบถามกลับโดยเสนอเฉพาะใบที่เข้าเงื่อนไข
 * มีบิลเปิดอยู่แต่ไม่มีใบไหนเข้าเงื่อนไข ใช้ error ของคำสั่งนั้น (none) บอกว่าทำไม
 */
export async function resolveBill(
  lineGroupId: string,
  title = "",
  fits: (bill: ActiveBill) => boolean = () => true,
  none: (open: ActiveBill[]) => AppError = () => new AppError("NO_BILL"),
): Promise<BillRow> {
  const wanted = title.trim();

  if (wanted) {
    const found = await findActiveBillByTitle(lineGroupId, wanted);
    if (!found) throw new AppError("NO_BILL", { title: wanted });
    return found;
  }

  const open = await listActiveBillsWithPayers(lineGroupId);
  if (open.length === 0) throw new AppError("NO_BILL");

  const matched = open.filter(fits);
  if (matched.length === 0) throw none(open);
  if (matched.length > 1) {
    throw new AppError("BILL_AMBIGUOUS", { titles: matched.map((bill) => bill.title) });
  }
  return matched[0]!;
}

/**
 * บิลที่ขอดู หรือถามว่าใครยังไม่จ่าย
 * ไม่ระบุชื่อจะข้ามใบที่ทุกคนจ่ายครบแล้ว เพราะถือว่าจบไปแล้ว อยากเปิดดูใบนั้นต้องระบุชื่อมา
 */
export async function getBill(lineGroupId: string, title = ""): Promise<BillView> {
  const bill = await resolveBill(
    lineGroupId,
    title,
    (candidate) => candidate.unpaid_user_ids.length > 0,
    (open) => new AppError("ALL_BILLS_SETTLED", { titles: open.map((settled) => settled.title) }),
  );
  return billView(bill);
}

/**
 * บิลพร้อมรายการและยอดของทุกคน
 * อ่านรอบจาก game_id ของบิลโดยตรง เพราะรอบอาจปิดไปแล้วแต่ยังตามเก็บเงินกันอยู่
 * บิลลอย ๆ ไม่มีรอบเลย ซึ่งไม่ใช่ error
 */
async function billView(bill: BillRow): Promise<BillView> {
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
  // ยกเลิกได้ทุกใบที่เปิดอยู่ รวมใบที่จ่ายครบแล้ว
  const view = await billView(await resolveBill(lineGroupId, title));
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

/**
 * บิลที่เริ่มจากปุ่ม "สร้างบิลใหม่" ให้ใช้ pending ใบเดิมต่อ ไม่สร้างใบใหม่
 * ชื่อที่ตั้งไว้กับคำสั่งมาก่อน ("คิดเงิน ร้านโชคดี") ชนะชื่อที่ LLM อ่านได้ทีหลัง
 * ยังไม่มีชื่อเลยต้องถามก่อน บิลลอย ๆ อ้างถึงด้วยชื่อ
 */
export async function continueNewBill(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  askedTitle: string,
): Promise<PendingActionRow> {
  const pending = await findUsablePendingAction(pendingId, lineGroupId);
  if (!pending || pending.action_type !== "create_bill" || pending.game_id !== null) {
    throw new AppError("PENDING_EXPIRED");
  }
  if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

  const title = String(pending.payload.title ?? "").trim() || askedTitle.trim();
  if (!title) throw new AppError("MISSING_FIELDS", { missing: ["title"] });
  await requireFreeTitle(lineGroupId, title);

  const saved = await updatePendingPayload(pending.id, { title });
  if (!saved) throw new AppError("PENDING_EXPIRED");
  return saved;
}

/** แก้บิลครั้งหนึ่งเพิ่มรายการได้ไม่เกินจำนวนรายการอื่น ๆ ตอนสร้างบิล */
export const MAX_ADDED_ITEMS = MAX_OTHER_ITEMS;

/** รายการที่จะเพิ่มตอนแก้บิล เก็บไว้ใน payload ของ pending จนกว่าจะกดยืนยัน */
export type AddedItem = { label: string; amount: number; payer_ids: string[] };

const editStateSchema = z.object({
  bill_id: z.string().min(1),
  add_items: z
    .array(z.object({ label: z.string(), amount: bahtSchema, payer_ids: z.array(z.string()) }))
    .default([]),
  remove_item_ids: z.array(z.string()).default([]),
});

export type BillEditState = { billId: string; added: AddedItem[]; removedIds: string[] };

/** อ่านสิ่งที่แก้ค้างไว้จาก payload ยังไม่ได้เลือกบิล = ยังไม่มีอะไรให้แก้ */
export function readEditState(payload: PendingPayload): BillEditState {
  const parsed = editStateSchema.safeParse(payload);
  if (!parsed.success) throw new AppError("PENDING_EXPIRED");

  return {
    billId: parsed.data.bill_id,
    added: parsed.data.add_items,
    removedIds: parsed.data.remove_item_ids,
  };
}

export type EditedItem = NewBillItem & {
  /** ใช้อ้างถึงตอนกดลบ: รายการเดิมใช้ id ส่วนรายการที่เพิ่งเพิ่มใช้ new<ลำดับ> */
  ref: string;
  added: boolean;
};

export type BillEditPlan = {
  /** รายการหลังแก้: ของเดิมที่เหลือตามลำดับเดิม แล้วต่อด้วยของใหม่ */
  items: EditedItem[];
  removed: BillItemRow[];
  shares: NewBillShare[];
  totalSatang: number;
  /** คนที่บอกว่าจ่ายแล้วแต่ยอดเปลี่ยน กดยืนยันแล้วจะกลับเป็นยังไม่จ่าย */
  resetPaid: BillShareRow[];
  /** คนที่บอกว่าจ่ายแล้วแต่ไม่เหลือรายการไหนในบิล กดยืนยันแล้วจะหลุดจากบิลไปพร้อมบันทึกนั้น */
  droppedPaid: BillShareRow[];
  changed: boolean;
};

/**
 * บิลหลังแก้หน้าตาเป็นยังไง คิดด้วยสูตรเดียวกับตอนสร้างบิล (หารทีละรายการ เศษตกที่คนสร้างบิล)
 *
 * รายการเดิมเก็บคนร่วมจ่ายชุดเดิม รายการใหม่ที่ไม่ระบุชื่อเก็บทุกคนในบิลตอนนี้
 * ใช้ทั้งตอนแสดงการ์ดและตอนกดยืนยัน ตัวเลขบนการ์ดกับในฐานข้อมูลจึงต่างกันไม่ได้
 */
export function planBillEdit(
  bill: BillRow,
  items: BillItemRow[],
  shares: BillShareRow[],
  edit: Pick<BillEditState, "added" | "removedIds">,
): BillEditPlan {
  // รายการที่เลือกลบไว้หายไปแล้ว แปลว่าบิลถูกแก้จากทางอื่นระหว่างนั้น ยืนยันต่อไม่ได้
  const known = new Set(items.map((item) => item.id));
  if (edit.removedIds.some((id) => !known.has(id))) throw new AppError("PENDING_EXPIRED");

  const kept = items.filter((item) => !edit.removedIds.includes(item.id));
  const everyone = shares.map((share) => share.user_id);

  const split = splitByItem(
    [
      ...kept.map((item) => ({
        item: {
          label: item.label,
          quantity: item.quantity,
          unit_price_satang: item.unit_price_satang,
          amount_satang: item.amount_satang,
        },
        payerIds: item.payers.map((payer) => payer.user_id),
      })),
      ...edit.added.map((added) => {
        const amount = toSatang(added.amount);
        return {
          item: { label: added.label, quantity: 1, unit_price_satang: amount, amount_satang: amount },
          payerIds: added.payer_ids.length > 0 ? added.payer_ids : everyone,
        };
      }),
    ],
    bill.created_by,
  );

  const after = new Map(split.shares.map((share) => [share.userId, share.amountSatang]));

  return {
    items: split.items.map((item, index) => ({
      ...item,
      ref: index < kept.length ? kept[index]!.id : `new${index - kept.length}`,
      added: index >= kept.length,
    })),
    removed: items.filter((item) => edit.removedIds.includes(item.id)),
    shares: split.shares,
    totalSatang: split.totalSatang,
    resetPaid: shares.filter(
      (share) => share.paid && after.has(share.user_id) && after.get(share.user_id) !== share.amount_satang,
    ),
    droppedPaid: shares.filter((share) => share.paid && !after.has(share.user_id)),
    changed: edit.removedIds.length > 0 || edit.added.length > 0,
  };
}

/** แก้บิลได้เฉพาะคนสร้างบิล ถามทีเดียวว่าใบไหน ถ้ามีใบเดียวก็เลือกให้เลย */
export async function startEditBill(
  lineGroupId: string,
  userId: string,
): Promise<{ pending: PendingActionRow; bills: BillRow[] }> {
  const bills = await listEditableBills(lineGroupId, userId);
  if (bills.length === 0) throw new AppError("NO_BILL");

  const only = bills.length === 1 ? bills[0] : undefined;
  const pending = await createPendingAction({
    lineGroupId,
    requestedBy: userId,
    actionType: "edit_bill",
    payload: only ? { bill_id: only.id } : {},
  });

  return { pending, bills };
}

/**
 * บันทึกสิ่งที่แก้เพิ่ม โดยใช้ pending ใบเดิมทิ้งแล้วเปิดใบใหม่ ไม่ใช่เขียนทับใบเดิม
 *
 * LINE แก้ข้อความที่ส่งไปแล้วไม่ได้ ทุกครั้งที่แก้จึงได้การ์ดใบใหม่ ส่วนใบเก่ายังค้างในแชท
 * ถ้าใช้ pending ใบเดียว กดยืนยันบนการ์ดใบเก่าจะยืนยันของล่าสุดซึ่งไม่ตรงกับที่การ์ดใบนั้นแสดง
 * แยกใบกันแล้วปุ่มบนการ์ดเก่าจะหมดอายุเอง
 */
export async function reviseBillEdit(pending: PendingActionRow, patch: PendingPayload): Promise<PendingActionRow> {
  const used = await consumePendingAction(pending.id, pending.line_group_id, getSql());
  if (!used || used.action_type !== "edit_bill") throw new AppError("PENDING_EXPIRED");

  return createPendingAction({
    lineGroupId: used.line_group_id,
    requestedBy: used.requested_by,
    actionType: "edit_bill",
    payload: { ...used.payload, ...patch, awaiting: null },
  });
}

/** เลือกบิลจากปุ่ม ต้องเป็นใบที่คนกดแก้ได้จริง ไม่ใช่เชื่อ id ที่มากับปุ่ม */
export async function selectBillToEdit(pending: PendingActionRow, billId: string): Promise<PendingActionRow> {
  const bills = await listEditableBills(pending.line_group_id, pending.requested_by);
  if (!bills.some((bill) => bill.id === billId)) throw new AppError("NO_BILL");

  return reviseBillEdit(pending, { bill_id: billId });
}

export type BillEditView = {
  bill: BillRow;
  items: BillItemRow[];
  shares: BillShareRow[];
  plan: BillEditPlan;
};

/** บิลที่กำลังแก้ พร้อมหน้าตาหลังแก้ เอาไว้วาดการ์ดให้ตรวจก่อนกดยืนยัน */
export async function loadBillEdit(pending: PendingActionRow): Promise<BillEditView> {
  const state = readEditState(pending.payload);
  const bills = await listEditableBills(pending.line_group_id, pending.requested_by);
  const bill = bills.find((row) => row.id === state.billId);
  if (!bill) throw new AppError("NO_BILL");

  const [items, shares] = await Promise.all([listBillItems(bill.id), listBillShares(bill.id)]);
  return { bill, items, shares, plan: planBillEdit(bill, items, shares, state) };
}

/**
 * ยืนยันแก้บิล ทำในทรานแซกชันเดียว: ใช้ pending action + แทนรายการ + ปรับยอดของทุกคน
 * คิดใหม่จากข้อมูลในฐานข้อมูลตอนกดยืนยัน ไม่ใช้ตัวเลขจากตอนแสดงการ์ด
 * ระหว่างนั้นอาจมีคนบอกว่าจ่ายแล้วเพิ่ม ซึ่งต้องนับด้วย
 */
export async function confirmEditBill(
  pendingId: string,
  lineGroupId: string,
  userId: string,
): Promise<BillView> {
  const billId = await getSql().begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending || pending.action_type !== "edit_bill") throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

    const state = readEditState(pending.payload);
    const bill = await findBillById(state.billId, tx);
    if (!bill || bill.status !== "sent" || bill.line_group_id !== lineGroupId) {
      throw new AppError("NO_BILL");
    }
    if (bill.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

    const plan = planBillEdit(
      bill,
      await listBillItems(bill.id, tx),
      await listBillShares(bill.id, tx),
      state,
    );
    if (!plan.changed) throw new AppError("NO_CHANGES");

    await replaceBillItems(bill.id, plan.items, plan.totalSatang, tx);
    await syncBillShares(bill.id, plan.shares, tx);
    return bill.id;
  });

  const bill = await findBillById(String(billId));
  if (!bill) throw new AppError("NO_BILL");

  return {
    bill,
    game: bill.game_id ? await findGameById(bill.game_id) : null,
    items: await listBillItems(bill.id),
    shares: await listBillShares(bill.id),
  };
}

export type PaymentResult = {
  bill: BillRow;
  shares: BillShareRow[];
  /** คนที่บันทึกสำเร็จ */
  people: { user: UserRow; amountSatang: number }[];
  /** คนที่อยู่ในสถานะนั้นอยู่แล้ว เช่นบอกว่าจ่ายแล้วซ้ำ ไม่มีอะไรเปลี่ยน */
  unchanged: UserRow[];
  /** คนที่ทำไม่ได้ เพราะไม่อยู่ในบิลหรือไม่มีสิทธิ์กดแทน */
  refused: { user: UserRow; reason: "not_in_bill" | "not_allowed" }[];
};

/**
 * บันทึกว่าจ่ายแล้วหรือยัง ของตัวเองหรือของคนอื่นก็ได้ (PRP §5.6)
 *
 * ไม่ระบุชื่อบิล เลือกเฉพาะใบที่มีอะไรให้เปลี่ยน (PRP guests-split-bills-and-digest §5.2)
 * "จ่ายแล้ว" ดูใบที่คนในคำสั่งยังค้าง ส่วน "ยังไม่จ่าย" ดูใบที่เคยบันทึกว่าจ่ายแล้ว
 * ซึ่งรวมใบที่จ่ายครบแล้วด้วย ไม่งั้นคนสุดท้ายที่กดผิดจนบิลครบจะย้อนไม่ได้
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
  const ids = people.map((person) => person.id);
  const hasSomeoneToChange = (candidate: ActiveBill) => {
    const toChange = paid ? candidate.unpaid_user_ids : candidate.paid_user_ids;
    return toChange.some((id) => ids.includes(id));
  };
  const nothingToChange = () =>
    new AppError(paid ? "NOTHING_OWED" : "NOTHING_PAID", {
      names: people.map((person) => person.display_name),
    });

  const bill = await resolveBill(lineGroupId, title, hasSomeoneToChange, nothingToChange);
  const before = await listBillShares(bill.id);
  const result: PaymentResult = { bill, shares: before, people: [], unchanged: [], refused: [] };

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

    // อยู่ในสถานะนั้นอยู่แล้วไม่นับว่าเพิ่งเปลี่ยน ยอดในข้อความจะได้ไม่รวมเงินที่บันทึกไปก่อนแล้ว
    const changed = await markSharePaid(bill.id, person.id, paid, paid ? actor.id : null);
    if (!changed) {
      result.unchanged.push(person);
      continue;
    }
    result.people.push({ user: person, amountSatang: share.amount_satang });
  }

  result.shares = result.people.length > 0 ? await listBillShares(bill.id) : before;
  return result;
}

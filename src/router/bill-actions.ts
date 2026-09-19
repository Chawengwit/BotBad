import { AppError } from "@/errors/app-errors";
import { getSql } from "@/lib/db";
import { getGeminiConfigOrNull } from "@/lib/env";
import type { LineMessage } from "@/lib/line";
import {
  askAgain,
  askEditItems,
  askNewBillCommand,
  askNewBillDetails,
  askWhichBillToEdit,
  askWhichItemToRemove,
  billCard,
  billMenu,
  confirmCancelBill,
  editBillCard,
  gameBillBlockedNote,
  paymentRecorded,
  paymentUndone,
  unpaidList,
} from "@/line/messages";
import { listActiveBills } from "@/repositories/bill.repository";
import {
  consumePendingAction,
  createPendingAction,
  updatePendingPayload,
  type PendingActionRow,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import type { LineUserRow } from "@/repositories/types";
import { findUserById } from "@/repositories/user.repository";
import {
  billMenuOptions,
  canBillRound,
  getBill,
  loadBillableRounds,
  loadBillEdit,
  markPayment,
  MAX_ADDED_ITEMS,
  parseItemLines,
  readEditState,
  reviseBillEdit,
  startCancelBill,
  startCreateBill,
  startEditBill,
  startGameBill,
  startNewBill,
  type AddedItem,
} from "@/services/bill.service";
import { parseNames, resolveOrCreateGuests, resolvePeople } from "@/services/people.service";
import { pickRound, type RoundSelector } from "@/services/round.service";
import { askWhichRound } from "./game-actions";
import { advanceBillWizard } from "./wizard";

/** งานที่ทำกับบิลของกลุ่ม กลุ่มมีบิลเปิดพร้อมกันได้หลายใบ จึงระบุชื่อบิลต่อท้ายได้ */

/**
 * "คิดเงิน" เฉย ๆ ถามก่อนว่าเงินเรื่องไหน: คิดค่ารอบ / สร้างบิลใหม่ / แก้บิลเดิม
 * เหลือทางเดียว (สร้างบิลใหม่) ก็ไปทางนั้นเลย ไม่ต้องให้กดปุ่มเดียวที่มีอยู่
 */
export async function doBillMenu(lineGroupId: string, user: LineUserRow): Promise<LineMessage[]> {
  const options = await billMenuOptions(lineGroupId, user.id);

  if (options.games.length === 0 && options.editableBills.length === 0) {
    const reason = options.gameBlocked
      ? gameBillBlockedNote(options.gameBlocked.game, options.gameBlocked.reason)
      : "";
    return doStartNewBill(lineGroupId, user, "", reason);
  }

  // ผูกการ์ดไว้กับ pending จะได้ให้เฉพาะคนสั่งกดได้ และกดได้ครั้งเดียว (spec §21)
  const pending = await createPendingAction({
    lineGroupId,
    requestedBy: user.id,
    actionType: "create_bill",
    payload: { bill_menu: true },
  });
  return [billMenu(pending.id, options)];
}

/**
 * ปุ่มบนการ์ด "คิดเงินอะไรดี?"
 * ใช้การ์ดเมนูทิ้งก่อนเริ่มทางที่เลือก กดสองปุ่มพร้อมกันจะได้ไม่เกิดสองงาน
 */
export async function doChooseBillKind(
  menu: PendingActionRow,
  kind: string,
  user: LineUserRow,
): Promise<LineMessage[]> {
  if (menu.payload.bill_menu !== true) throw new AppError("INTERNAL_ERROR");
  if (kind !== "game" && kind !== "new" && kind !== "edit") throw new AppError("INTERNAL_ERROR");

  const used = await consumePendingAction(menu.id, menu.line_group_id, getSql());
  if (!used) throw new AppError("PENDING_EXPIRED");

  if (kind === "game") return doStartGameBill(menu.line_group_id, user);
  if (kind === "new") return doStartNewBill(menu.line_group_id, user);
  return doStartEditBill(menu.line_group_id, user);
}

/**
 * คิดค่ารอบ: ค่าคอร์ท → ลูกแบด → ค่าอื่น ๆ → การ์ดยืนยัน
 * เลือกจากเกมที่ยังเปิดอยู่หรือเพิ่งปิด (PRP multi-open-rounds §5.1) หลายเกมถามว่ารอบไหน
 * patch = รายการที่ LLM รู้มาแล้วทั้งชุด ถ้าต้องถามรอบก่อนก็จำไว้ในการ์ด กดแล้วไปการ์ดยืนยันบิลเลย
 */
export async function doStartGameBill(
  lineGroupId: string,
  user: LineUserRow,
  selector: RoundSelector = {},
  patch: PendingPayload = {},
): Promise<LineMessage[]> {
  const pick = pickRound(await loadBillableRounds(lineGroupId), (round) => canBillRound(round, user.id), selector);

  if (pick.kind === "choose") return askWhichRound(lineGroupId, user, "bill", pick.rounds, { patch });
  if (pick.kind === "none") {
    const mine = pick.rounds.some((round) => round.game.created_by === user.id);
    throw new AppError(mine ? "NO_PLAYERS_TO_SPLIT" : "NOT_GAME_CREATOR");
  }

  const { pending } = await startGameBill(lineGroupId, user.id, pick.round.game.id);
  return advanceBillWizard(pending, patch);
}

/**
 * บิลใหม่ที่ไม่ผูกกับรอบ
 * มี Gemini: พิมพ์ชื่อบิลกับรายการมาอิสระ แล้วให้ Gemini แปลง
 * ไม่มี Gemini: ต้องตั้งชื่อมากับคำสั่ง แล้วตอบทีละขั้นแบบเดิม บอทต้องใช้ได้แม้ไม่มี LLM (spec §19)
 */
export async function doStartNewBill(
  lineGroupId: string,
  user: LineUserRow,
  title = "",
  reason = "",
): Promise<LineMessage[]> {
  const wanted = title.trim();

  if (getGeminiConfigOrNull()) {
    await startNewBill(lineGroupId, user.id, wanted);
    return [askNewBillDetails(wanted, reason)];
  }

  if (!wanted) return [askNewBillCommand(reason)];

  const { pending } = await startCreateBill(lineGroupId, user.id, wanted);
  return advanceBillWizard(pending, {});
}

/** แก้บิลเดิม มีหลายใบถามก่อนว่าใบไหน ใบเดียวไปการ์ดแก้บิลเลย */
export async function doStartEditBill(lineGroupId: string, user: LineUserRow): Promise<LineMessage[]> {
  const { pending, bills } = await startEditBill(lineGroupId, user.id);
  return bills.length > 1 ? [askWhichBillToEdit(pending.id, bills)] : showBillEdit(pending);
}

/** การ์ดแก้บิลจากสิ่งที่แก้ค้างไว้ใน pending วาดใหม่ทุกครั้งที่เพิ่มหรือลบรายการ */
export async function showBillEdit(pending: PendingActionRow): Promise<LineMessage[]> {
  const view = await loadBillEdit(pending);
  const names = new Map<string, string>([
    ...view.shares.map((share) => [share.user_id, share.display_name] as const),
    ...view.items.flatMap((item) => item.payers.map((payer) => [payer.user_id, payer.display_name] as const)),
    ...Object.entries((pending.payload.payer_names ?? {}) as Record<string, string>),
  ]);

  const added = readEditState(pending.payload).added.length;
  return [editBillCard(pending.id, view.bill, view.plan, names, added < MAX_ADDED_ITEMS)];
}

/** ปุ่มบนการ์ดแก้บิล: เพิ่มรายการ / ลบรายการ / กลับจากหน้าเลือกรายการ */
export async function doEditBillAction(pending: PendingActionRow, value: string): Promise<LineMessage[]> {
  if (value === "add") {
    // รายการพิมพ์ตอบ ต้องจำไว้ว่าข้อความถัดไปของคนนี้คือรายการที่จะเพิ่ม
    const saved = await updatePendingPayload(pending.id, { awaiting: "bill_edit_add" });
    if (!saved) throw new AppError("PENDING_EXPIRED");
    return [askEditItems()];
  }

  if (value === "remove") {
    const { plan } = await loadBillEdit(pending);
    return [askWhichItemToRemove(pending.id, plan)];
  }

  if (value === "back") return showBillEdit(pending);
  throw new AppError("INTERNAL_ERROR");
}

/**
 * ลบรายการหนึ่งออก รายการเดิมจดไว้ว่าจะลบ ส่วนรายการที่เพิ่งเพิ่มในรอบนี้ก็เอาออกจากที่จดไว้
 * กดปุ่มจากหน้าเลือกรายการที่เก่าแล้ว (รายการไม่มีอยู่แล้ว) ถือว่าปุ่มหมดอายุ
 */
export async function doRemoveBillItem(pending: PendingActionRow, ref: string): Promise<LineMessage[]> {
  const { plan } = await loadBillEdit(pending);
  const target = plan.items.find((item) => item.ref === ref);
  // บิลต้องเหลืออย่างน้อยหนึ่งรายการ ปุ่มลบไม่ขึ้นอยู่แล้ว แต่กันปุ่มเก่าไว้ด้วย
  if (!target || plan.items.length <= 1) throw new AppError("PENDING_EXPIRED");

  const state = readEditState(pending.payload);
  const patch: PendingPayload = target.added
    ? { add_items: state.added.filter((_, index) => `new${index}` !== ref) }
    : { remove_item_ids: [...state.removedIds, ref] };

  return showBillEdit(await reviseBillEdit(pending, patch));
}

/**
 * รายการที่พิมพ์มาเพิ่มเข้าบิล บรรทัดละรายการ รูปแบบเดียวกับตอนสร้างบิล
 * ชื่อที่ยังไม่รู้จักถือว่าเป็นแขก สร้างให้เลย เพราะคนพิมพ์กำลังบอกว่าใครกินใครใช้
 */
export async function doAddBillItems(pending: PendingActionRow, text: string): Promise<LineMessage[]> {
  const lines = parseItemLines(text);
  if (!lines) {
    return [askAgain('➕ อ่านรายการไม่ออก พิมพ์ชื่อรายการกับจำนวนเงิน บรรทัดละรายการ เช่น "ค่าน้ำแข็ง 40"')];
  }

  const state = readEditState(pending.payload);
  if (state.added.length + lines.length > MAX_ADDED_ITEMS) {
    return [askAgain(`➕ แก้ครั้งหนึ่งเพิ่มได้ไม่เกิน ${MAX_ADDED_ITEMS} รายการ`)];
  }

  const actor = (await findUserById(pending.requested_by)) ?? {
    id: pending.requested_by,
    line_user_id: null,
    line_group_id: null,
    display_name: "",
  };
  const names = { ...((pending.payload.payer_names ?? {}) as Record<string, string>) };
  const added: AddedItem[] = [];

  for (const line of lines) {
    const people =
      line.payerNames.length > 0
        ? await resolveOrCreateGuests(pending.line_group_id, line.payerNames, actor)
        : [];
    for (const person of people) names[person.id] = person.display_name;
    added.push({ label: line.label, amount: line.amount, payer_ids: people.map((person) => person.id) });
  }

  return showBillEdit(
    await reviseBillEdit(pending, { add_items: [...state.added, ...added], payer_names: names }),
  );
}

export async function doShowBill(lineGroupId: string, title = ""): Promise<LineMessage[]> {
  const { bill, items, shares } = await getBill(lineGroupId, title);
  return [billCard(bill, items, shares)];
}

export async function doUnpaidList(lineGroupId: string, title = ""): Promise<LineMessage[]> {
  const { bill, shares } = await getBill(lineGroupId, title);
  return [unpaidList(bill, shares)];
}

/**
 * บันทึกการจ่าย ของตัวเองหรือของคนอื่น (PRP guests-split-bills-and-digest §5.6)
 *
 * ส่วนเติมท้ายเป็นได้สามแบบ: ชื่อบิล / รายชื่อคน / รายชื่อคนตามด้วยชื่อบิล เช่น "วิท ฮก ร้านโชคดี"
 * แยกด้วยการเทียบท้ายข้อความกับชื่อบิลที่เปิดอยู่ ชื่อบิลเป็นข้อความที่ผู้ใช้ตั้งเองจึงไม่กำกวม
 */
export async function doMarkPayment(
  lineGroupId: string,
  user: LineUserRow,
  paid: boolean,
  args = "",
): Promise<LineMessage[]> {
  const trimmed = args.trim();
  const title = trimmed ? await trailingBillTitle(lineGroupId, trimmed) : "";

  const names = parseNames(trimmed.slice(0, trimmed.length - title.length));
  const people =
    names.length > 0
      ? await resolvePeopleOrThrow(lineGroupId, names, user)
      : [user];

  const result = await markPayment(lineGroupId, user, people, paid, title);

  return [
    paid
      ? paymentRecorded(user.display_name, result)
      : paymentUndone(user.display_name, result),
  ];
}

/**
 * ชื่อบิลที่เปิดอยู่ซึ่งข้อความนี้ลงท้ายด้วย ไม่เจอคืนสตริงว่าง
 * ชื่อบิลมีช่องว่างได้ เลือกชื่อที่ยาวที่สุดที่ตรง และต้องขึ้นต้นหลังช่องว่างหรือคอมมา
 * ไม่งั้นชื่อคนที่บังเอิญลงท้ายเหมือนชื่อบิลจะถูกตัดครึ่ง
 */
async function trailingBillTitle(lineGroupId: string, text: string): Promise<string> {
  const lower = text.toLowerCase();
  const matched = (await listActiveBills(lineGroupId))
    .map((bill) => bill.title)
    .filter((title) => {
      const before = lower.slice(0, lower.length - title.length);
      return lower.endsWith(title.toLowerCase()) && (before === "" || /[\s,]$/u.test(before));
    })
    .sort((a, b) => b.length - a.length);

  // ตัดจากข้อความที่พิมพ์มาจริง ไม่ใช่ชื่อในระบบ ตัวพิมพ์เล็กใหญ่จะได้ตรงกับที่เหลือเป็นรายชื่อ
  return matched[0] ? text.slice(text.length - matched[0].length) : "";
}

async function resolvePeopleOrThrow(
  lineGroupId: string,
  names: string[],
  user: LineUserRow,
) {
  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });
  if (people.length === 0) throw new AppError("PERSON_NOT_FOUND", { names: unknown });
  return people;
}

export async function doCancelBill(
  lineGroupId: string,
  user: LineUserRow,
  title = "",
): Promise<LineMessage[]> {
  const { pending, view } = await startCancelBill(lineGroupId, user.id, title);
  return [confirmCancelBill(pending.id, view.bill, view.shares)];
}

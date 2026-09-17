import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  askCourtCount,
  askCourtFee,
  askCourtName,
  askDate,
  askDuration,
  askExtraItem,
  askLocation,
  askMaxPlayers,
  askPromptPay,
  askSameVenue,
  askShuttleCount,
  askShuttlePrice,
  askTime,
  askWhen,
  confirmBill,
  confirmCreateGame,
  confirmEditGame,
} from "@/line/messages";
import { findLastShuttlePrice } from "@/repositories/bill.repository";
import { buildBillItems, draftFromPayload, totalOf } from "@/services/bill.service";
import {
  countJoinedPlayers,
  findGameById,
  findLatestPromptPay,
  findLatestVenue,
  findOpenGame,
} from "@/repositories/game.repository";
import {
  updatePendingPayload,
  type PendingActionRow,
  type PendingPayload,
} from "@/repositories/pending-action.repository";
import { editPatchSchema, validatePatch, withDerivedMaxPlayers } from "@/services/game-admin.service";
import {
  defaultMaxPlayers,
  gameDraftSchema,
  missingDraftFields,
  type DraftField,
} from "@/services/game.service";

/** คำถามของแต่ละช่อง ใช้ตอนแก้ไขรอบ ซึ่งแก้ทีละช่อง */
export function questionFor(
  field: DraftField | "max_players" | "location_url" | "promptpay",
  pendingId: string,
  courtCount: number,
  lastPromptPay: string | null = null,
): LineMessage {
  switch (field) {
    case "court_count":
      return askCourtCount(pendingId);
    case "max_players":
      return askMaxPlayers(pendingId, courtCount);
    case "play_date":
      return askDate(pendingId);
    case "start_time":
      return askTime(pendingId);
    case "duration_minutes":
      return askDuration(pendingId);
    case "court_name":
      return askCourtName();
    case "location_url":
      return askLocation(pendingId);
    case "promptpay":
      return askPromptPay(pendingId, lastPromptPay);
  }
}

/**
 * เดินหน้า wizard เปิดรอบไปอีกขั้น
 * เขียนลงฐานข้อมูลเฉพาะช่องที่เปลี่ยน (merge) ส่วนการตัดสินใจว่าจะถามอะไรต่อคำนวณจากค่าที่รวมกันแล้ว
 * ช่องที่ต้องพิมพ์ตอบจะบันทึก awaiting ไว้ เพื่อให้รู้ว่าข้อความถัดไปคือคำตอบของอะไร
 *
 * ลำดับคำถาม: กี่คอร์ท → เมื่อไหร่ → กี่ชั่วโมง → ที่เดิมไหม → ยืนยัน
 * ก๊วนที่ยังไม่เคยเปิดรอบจะถูกถามชื่อคอร์ท แผนที่ และพร้อมเพย์ทีละข้อแทนขั้น "ที่เดิมไหม"
 */
export async function advanceCreateWizard(
  pending: PendingActionRow,
  patch: PendingPayload,
): Promise<LineMessage[]> {
  // จำนวนคนคิดจากคอร์ทให้เลย ไม่ต้องถาม (spec §9.1)
  const withDefaults: PendingPayload =
    patch.court_count !== undefined && pending.payload.max_players === undefined
      ? { ...patch, max_players: defaultMaxPlayers(Number(patch.court_count)) }
      : patch;

  const payload = { ...pending.payload, ...withDefaults };
  const next = missingDraftFields(payload)[0];

  if (next && next !== "court_name") {
    await save(pending.id, { ...withDefaults, awaiting: null });
    return [await createQuestion(next, pending)];
  }

  // ยังไม่รู้ว่าไปตีที่ไหน ถ้ากลุ่มเคยเปิดรอบมาก่อน เสนอที่เดิมให้กดทีเดียวจบ
  if (next === "court_name") {
    const venue = payload.venue_asked === true ? null : await findLatestVenue(pending.line_group_id);

    if (venue) {
      await save(pending.id, { ...withDefaults, awaiting: null, venue_asked: true });
      return [
        askSameVenue(
          pending.id,
          venue.court_name,
          venue.location_url !== null,
          await findLatestPromptPay(pending.line_group_id),
        ),
      ];
    }

    await save(pending.id, { ...withDefaults, awaiting: "court_name", venue_asked: true });
    return [askCourtName()];
  }

  // ข้อมูลครบแล้ว ถามเรื่องแผนที่อีกหนึ่งครั้ง (ข้ามได้)
  if (payload.location_url === undefined && payload.location_asked !== true) {
    await save(pending.id, { ...withDefaults, awaiting: "location", location_asked: true });
    return [askLocation(pending.id)];
  }

  // เลขพร้อมเพย์ก็ข้ามได้เหมือนกัน ถามครั้งเดียวจบ ไม่วนถามซ้ำ
  if (payload.promptpay === undefined && payload.promptpay_asked !== true) {
    const lastUsed = await findLatestPromptPay(pending.line_group_id);
    await save(pending.id, { ...withDefaults, awaiting: "promptpay", promptpay_asked: true });
    return [askPromptPay(pending.id, lastUsed)];
  }

  await save(pending.id, { ...withDefaults, awaiting: null });
  return [confirmCreateGame(pending.id, gameDraftSchema.parse(payload))];
}

/** คำถามของ wizard เปิดรอบ วันกับเวลาถามพร้อมกันในขั้นเดียว */
async function createQuestion(
  field: Exclude<DraftField, "court_name">,
  pending: PendingActionRow,
): Promise<LineMessage> {
  switch (field) {
    case "court_count":
      return askCourtCount(pending.id);
    case "play_date":
    case "start_time": {
      const venue = await findLatestVenue(pending.line_group_id);
      return askWhen(pending.id, venue?.start_time);
    }
    case "duration_minutes":
      return askDuration(pending.id);
  }
}

/**
 * เดินหน้า wizard คิดเงิน
 * ลำดับคำถาม: ค่าคอร์ท → กี่ลูก → ลูกละเท่าไหร่ → ค่าอื่น ๆ → การ์ดยืนยัน
 * ช่องที่ข้ามไปเก็บเป็น null เพื่อแยกจาก "ยังไม่ได้ถาม" (undefined)
 */
export async function advanceBillWizard(
  pending: PendingActionRow,
  patch: PendingPayload,
): Promise<LineMessage[]> {
  const payload = { ...pending.payload, ...patch };

  if (payload.court_fee === undefined) {
    // ตอบด้วยปุ่มหรือพิมพ์ตัวเลขมาก็ได้ จึงต้องจำไว้ว่ากำลังรอคำตอบอะไร
    await save(pending.id, { ...patch, awaiting: "bill_court_fee" });
    return [askCourtFee(pending.id)];
  }

  if (payload.shuttle_count === undefined) {
    await save(pending.id, { ...patch, awaiting: null });
    return [askShuttleCount(pending.id)];
  }

  if (Number(payload.shuttle_count) > 0 && payload.shuttle_price === undefined) {
    await save(pending.id, { ...patch, awaiting: "bill_shuttle_price" });
    return [askShuttlePrice(pending.id, await findLastShuttlePrice(pending.line_group_id))];
  }

  if (payload.extras_done !== true) {
    await save(pending.id, { ...patch, awaiting: null });
    return [askExtraItem(pending.id)];
  }

  await save(pending.id, { ...patch, awaiting: null });

  const game = await findGameById(String(pending.game_id));
  if (!game) throw new AppError("NO_OPEN_GAME");

  const items = buildBillItems(draftFromPayload(payload));
  return [
    confirmBill(pending.id, game, items, totalOf(items), await countJoinedPlayers(game.id)),
  ];
}

/** แก้ไขทีละช่อง เลือกค่าเสร็จก็ไปการ์ดยืนยันเลย */
export async function advanceEditWizard(
  pendingId: string,
  lineGroupId: string,
  field: string,
  value: number | string,
): Promise<LineMessage[]> {
  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");

  // เปลี่ยนจำนวนคอร์ทอาจกระทบจำนวนคนที่รับ ต้องคิดให้ครบก่อนเอาไปแสดงบนการ์ด
  const patch = withDerivedMaxPlayers(game, editPatchSchema.parse({ [field]: value }));

  // ตรวจตั้งแต่ตอนนี้ จะได้ไม่ให้กดยืนยันไปแล้วค่อยบอกว่าไม่ได้
  validatePatch(game, patch, await countJoinedPlayers(game.id));

  await save(pendingId, { ...(patch as PendingPayload), awaiting: null });
  return [confirmEditGame(pendingId, game, patch)];
}

async function save(pendingId: string, patch: PendingPayload): Promise<void> {
  const saved = await updatePendingPayload(pendingId, patch);
  if (!saved) throw new AppError("PENDING_EXPIRED");
}

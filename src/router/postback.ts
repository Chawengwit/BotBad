import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { addDays, DATE_PATTERN, TIME_PATTERN, todayInBangkok } from "@/lib/time";
import {
  actionRejected,
  askAmount,
  askOtherItem,
  billCancelled,
  billCard,
  gameCancelled,
  gameCard,
  gameClosed,
  NAG_AFTER_CHANGES,
  nagEdits,
} from "@/line/messages";
import { findLatestPromptPay, findLatestVenue, findOpenGame } from "@/repositories/game.repository";
import {
  expirePendingAction,
  findUsablePendingAction,
  updatePendingPayload,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import { clearSession } from "@/repositories/session.repository";
import type { LineUserRow } from "@/repositories/types";
import { applyCancelGame, applyCloseGame, applyEditGame } from "@/services/game-admin.service";
import {
  confirmCreateGame as confirmCreateGameService,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from "@/services/game.service";
import { confirmCancelBill, confirmCreateBill, unpaidSharesForGame } from "@/services/bill.service";
import { doMarkPayment, doUnpaidList } from "./bill-actions";
import { doJoin, doLeave, doList } from "./game-actions";
import { advanceBillWizard, advanceCreateWizard, advanceEditWizard, questionFor } from "./wizard";

/** ข้อมูลที่แนบมากับปุ่ม เป็น query string และต้อง validate ทุกครั้ง (spec §18) */
const postbackSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wizard"),
    pending_id: z.uuid(),
    // field = เลือกว่าจะแก้อะไร (เฉพาะตอนแก้ไขรอบ) ที่เหลือคือค่าที่เลือกมา
    step: z.enum([
      "field",
      "court",
      "max",
      // "when" ถามวันและเวลาพร้อมกันตอนเปิดรอบ ส่วน "date"/"time" ใช้ตอนแก้ไขทีละช่อง
      "when",
      "date",
      "time",
      "duration",
      "venue",
      "location",
      "promptpay",
      // ขั้นของ wizard คิดเงิน
      "court_fee",
      "shuttle_count",
      "shuttle_price",
      "extra",
    ]),
    value: z.string().min(1).max(40),
  }),
  z.object({ action: z.literal("confirm"), pending_id: z.uuid() }),
  z.object({ action: z.literal("reject"), pending_id: z.uuid() }),
  // ปุ่มบนการ์ดรอบตี ทำกับรอบที่เปิดอยู่ของกลุ่มนั้น ไม่ต้องอ้างรอบ
  z.object({ action: z.literal("join") }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("list") }),
  // ปุ่มบนการ์ดบิล ทำกับบิลที่ยังใช้งานอยู่ของกลุ่มนั้น ไม่ต้องอ้างบิล
  z.object({ action: z.literal("bill_paid") }),
  z.object({ action: z.literal("bill_unpaid") }),
  z.object({ action: z.literal("bill_status") }),
]);

export type PostbackParams = { date?: string; time?: string; datetime?: string };
export type PostbackData = z.infer<typeof postbackSchema>;

type DraftStep = "court" | "max" | "when" | "date" | "time" | "duration";

export function parsePostbackData(data: string): PostbackData | null {
  const parsed = postbackSchema.safeParse(Object.fromEntries(new URLSearchParams(data)));
  return parsed.success ? parsed.data : null;
}

/**
 * แปลงค่าที่กดมาเป็นค่าที่จะเก็บลง payload
 * คืนเป็นชุด เพราะปุ่ม "เมื่อไหร่" ให้ทั้งวันและเวลามาพร้อมกัน
 */
function draftValue(
  step: DraftStep,
  value: string,
  params: PostbackParams,
  today: string,
): Record<string, number | string> {
  switch (step) {
    case "court": {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new AppError("INTERNAL_ERROR");
      return { court_count: count };
    }
    case "max": {
      const count = Number(value);
      if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
        throw new AppError("INTERNAL_ERROR");
      }
      return { max_players: count };
    }
    case "when": {
      // ปุ่มลัดฝังวันเวลามาเลย ส่วน picker ส่งมาเป็น "yyyy-MM-ddTHH:mm"
      const raw = value === "picker" ? (params.datetime ?? "").replace("T", " ") : value;
      const [date = "", time = ""] = raw.split(" ");
      if (!DATE_PATTERN.test(date) || !TIME_PATTERN.test(time)) {
        throw new AppError("INTERNAL_ERROR");
      }
      return { play_date: date, start_time: time };
    }
    case "date": {
      const date =
        value === "today" ? today : value === "tomorrow" ? addDays(today, 1) : (params.date ?? "");
      if (!DATE_PATTERN.test(date)) throw new AppError("INTERNAL_ERROR");
      return { play_date: date };
    }
    case "time": {
      const time = value === "picker" ? (params.time ?? "") : value;
      if (!TIME_PATTERN.test(time)) throw new AppError("INTERNAL_ERROR");
      return { start_time: time };
    }
    case "duration": {
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 60 !== 0) {
        throw new AppError("INTERNAL_ERROR");
      }
      return { duration_minutes: minutes };
    }
  }
}

/** ปุ่มในเมนูแก้ไข → ช่องที่จะถามต่อ */
const EDIT_FIELD_QUESTIONS = {
  court: "court_count",
  max: "max_players",
  date: "play_date",
  time: "start_time",
  duration: "duration_minutes",
  name: "court_name",
  location: "location_url",
  promptpay: "promptpay",
} as const;

async function handleConfirm(
  pending: PendingActionRow,
  lineGroupId: string,
  user: LineUserRow,
): Promise<LineMessage[]> {
  const userId = user.id;
  const messages = await runConfirm(pending, lineGroupId, userId);

  // จบเรื่องแล้ว ไม่ต้องให้ LLM จำบทสนทนาเดิมไปเสนอซ้ำ (LLM Design §10)
  await clearSession(lineGroupId, user.line_user_id).catch(() => {});
  return messages;
}

async function runConfirm(
  pending: PendingActionRow,
  lineGroupId: string,
  userId: string,
): Promise<LineMessage[]> {
  switch (pending.action_type) {
    case "create_game": {
      const game = await confirmCreateGameService(pending.id, lineGroupId, userId);
      return [gameCard(game, 0, "🏸 เปิดรอบตีแล้ว")];
    }
    case "edit_game": {
      const { game, joinedCount } = await applyEditGame(pending.id, lineGroupId, userId);
      return [
        gameCard(game, joinedCount, "✏️ แก้ไขรอบเรียบร้อย"),
        ...(game.edit_count >= NAG_AFTER_CHANGES ? [nagEdits(game.edit_count)] : []),
      ];
    }
    case "cancel_game": {
      await applyCancelGame(pending.id, lineGroupId, userId);
      return [gameCancelled()];
    }
    case "close_game": {
      const { game } = await applyCloseGame(pending.id, lineGroupId, userId);
      // บิลไม่ได้ปิดตามรอบ ยังตามเก็บเงินกันต่อได้ (PRP §5.7)
      return [gameClosed(await unpaidSharesForGame(game.id))];
    }
    case "create_bill": {
      const { bill, items, shares } = await confirmCreateBill(pending.id, lineGroupId, userId);
      return [billCard(bill, items, shares, "💰 คิดเงินแล้ว")];
    }
    case "cancel_bill": {
      await confirmCancelBill(pending.id, lineGroupId, userId);
      return [billCancelled()];
    }
  }
}

/** เลือกจากเมนูแก้ไขว่าจะแก้อะไร แล้วถามค่าใหม่ของช่องนั้น */
async function handleEditFieldChoice(
  pending: PendingActionRow,
  lineGroupId: string,
  choice: string,
): Promise<LineMessage[]> {
  const field = EDIT_FIELD_QUESTIONS[choice as keyof typeof EDIT_FIELD_QUESTIONS];
  if (!field) throw new AppError("INTERNAL_ERROR");

  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");

  // ช่องที่ต้องพิมพ์ตอบ ต้องจำไว้ว่ากำลังรอคำตอบอะไรอยู่
  const AWAITING_BY_FIELD = {
    court_name: "court_name",
    location_url: "location",
    promptpay: "promptpay",
  } as const;
  const awaiting = AWAITING_BY_FIELD[field as keyof typeof AWAITING_BY_FIELD];
  if (awaiting) {
    const saved = await updatePendingPayload(pending.id, { awaiting });
    if (!saved) throw new AppError("PENDING_EXPIRED");
  }

  const lastPromptPay = field === "promptpay" ? await findLatestPromptPay(lineGroupId) : null;
  return [questionFor(field, pending.id, game.court_count, lastPromptPay)];
}

const BILL_STEPS = ["court_fee", "shuttle_count", "shuttle_price", "extra"] as const;
type BillStep = (typeof BILL_STEPS)[number];

function isBillStep(step: string): step is BillStep {
  return (BILL_STEPS as readonly string[]).includes(step);
}

/**
 * ปุ่มของ wizard คิดเงิน
 * ค่าที่ต้องพิมพ์ตอบ (ค่าน้ำ, รายการอื่น) แค่จำไว้ว่ากำลังรออะไร แล้วถามเป็นข้อความ
 */
async function handleBillStep(
  pending: PendingActionRow,
  step: BillStep,
  value: string,
): Promise<LineMessage[]> {
  if (step === "extra") {
    if (value === "done") return advanceBillWizard(pending, { extras_done: true });

    const awaiting = value === "water" ? "bill_water" : "bill_other";
    const saved = await updatePendingPayload(pending.id, { awaiting });
    if (!saved) throw new AppError("PENDING_EXPIRED");

    return [value === "water" ? askAmount("ค่าน้ำ") : askOtherItem()];
  }

  if (step === "court_fee") {
    return advanceBillWizard(pending, { court_fee: value === "skip" ? null : Number(value) });
  }

  if (step === "shuttle_count") {
    const count = Number(value);
    // ไม่ใช้ลูกแบดก็ไม่ต้องถามราคา
    return advanceBillWizard(pending, {
      shuttle_count: count,
      ...(count === 0 ? { shuttle_price: null } : {}),
    });
  }

  return advanceBillWizard(pending, { shuttle_price: Number(value) });
}

/**
 * จัดการปุ่มที่ผู้ใช้กด
 * ทุกปุ่มที่อ้าง pending action ต้องเป็นของคนที่สั่งเท่านั้น และใช้ได้เฉพาะที่ยังไม่หมดอายุ (spec §21)
 */
export async function handlePostback(
  parsed: PostbackData,
  input: {
    params: PostbackParams;
    lineGroupId: string;
    user: LineUserRow;
  },
): Promise<LineMessage[]> {
  const userId = input.user.id;

  if (parsed.action === "bill_paid") return doMarkPayment(input.lineGroupId, input.user, true);
  if (parsed.action === "bill_unpaid") return doMarkPayment(input.lineGroupId, input.user, false);
  if (parsed.action === "bill_status") return doUnpaidList(input.lineGroupId);

  if (parsed.action === "join") return doJoin(input.lineGroupId, input.user);
  if (parsed.action === "leave") return doLeave(input.lineGroupId, input.user);
  if (parsed.action === "list") return doList(input.lineGroupId);

  const pending = await findUsablePendingAction(parsed.pending_id, input.lineGroupId);
  if (!pending) throw new AppError("PENDING_EXPIRED");
  if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

  if (parsed.action === "reject") {
    await expirePendingAction(pending.id, input.lineGroupId);
    return [actionRejected(pending.action_type)];
  }

  if (parsed.action === "confirm") {
    return handleConfirm(pending, input.lineGroupId, input.user);
  }

  if (parsed.step === "field") {
    if (pending.action_type !== "edit_game") throw new AppError("INTERNAL_ERROR");
    return handleEditFieldChoice(pending, input.lineGroupId, parsed.value);
  }

  if (isBillStep(parsed.step)) {
    if (pending.action_type !== "create_bill") throw new AppError("INTERNAL_ERROR");
    return handleBillStep(pending, parsed.step, parsed.value);
  }

  if (parsed.step === "promptpay") {
    // ปุ่มบนคำถามเลขพร้อมเพย์มีสองอย่าง: ข้ามไปเลย หรือใช้เลขเดิมของกลุ่ม
    if (parsed.value !== "skip" && parsed.value !== "reuse") throw new AppError("INTERNAL_ERROR");

    const lastUsed = parsed.value === "reuse" ? await findLatestPromptPay(input.lineGroupId) : null;

    if (pending.action_type === "edit_game") {
      if (!lastUsed) {
        await expirePendingAction(pending.id, input.lineGroupId);
        return [actionRejected(pending.action_type)];
      }
      return advanceEditWizard(pending.id, input.lineGroupId, "promptpay", lastUsed);
    }

    return advanceCreateWizard(pending, {
      promptpay_asked: true,
      ...(lastUsed ? { promptpay: lastUsed } : {}),
    });
  }

  if (parsed.step === "venue") {
    // ปุ่ม "ที่เดิม / เปลี่ยนที่" มีเฉพาะตอนเปิดรอบ
    if (pending.action_type !== "create_game") throw new AppError("INTERNAL_ERROR");
    if (parsed.value !== "same" && parsed.value !== "change") throw new AppError("INTERNAL_ERROR");

    if (parsed.value === "change") return advanceCreateWizard(pending, {});

    const venue = await findLatestVenue(input.lineGroupId);
    if (!venue) throw new AppError("INTERNAL_ERROR");

    const promptpay = await findLatestPromptPay(input.lineGroupId);
    return advanceCreateWizard(pending, {
      court_name: venue.court_name,
      // ที่เดิมแปลว่าแผนที่และเลขโอนก็เหมือนเดิม ไม่ต้องไล่ถามซ้ำอีกสามคำถาม
      ...(venue.location_url ? { location_url: venue.location_url } : {}),
      location_asked: true,
      ...(promptpay ? { promptpay } : {}),
      promptpay_asked: true,
    });
  }

  if (parsed.step === "location") {
    // ปุ่มข้าม: เปิดรอบต่อโดยไม่มีแผนที่ ส่วนตอนแก้ไขคือไม่เปลี่ยนอะไร
    if (parsed.value !== "skip") throw new AppError("INTERNAL_ERROR");
    if (pending.action_type === "edit_game") {
      await expirePendingAction(pending.id, input.lineGroupId);
      return [actionRejected(pending.action_type)];
    }
    return advanceCreateWizard(pending, { location_asked: true });
  }

  const patch = draftValue(parsed.step, parsed.value, input.params, todayInBangkok());

  if (pending.action_type === "edit_game") {
    // เมนูแก้ไขถามทีละช่อง จึงได้ค่ากลับมาช่องเดียวเสมอ
    const [field, value] = Object.entries(patch)[0] ?? [];
    if (field === undefined || value === undefined) throw new AppError("INTERNAL_ERROR");
    return advanceEditWizard(pending.id, input.lineGroupId, field, value);
  }

  return advanceCreateWizard(pending, patch);
}

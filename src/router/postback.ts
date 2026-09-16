import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { addDays, DATE_PATTERN, TIME_PATTERN, todayInBangkok } from "@/lib/time";
import { actionRejected, gameCancelled, gameCard, gameClosed } from "@/line/messages";
import { findLatestPromptPay, findOpenGame } from "@/repositories/game.repository";
import {
  expirePendingAction,
  findUsablePendingAction,
  updatePendingPayload,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import { clearSession } from "@/repositories/session.repository";
import type { UserRow } from "@/repositories/types";
import { applyCancelGame, applyCloseGame, applyEditGame } from "@/services/game-admin.service";
import {
  confirmCreateGame as confirmCreateGameService,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from "@/services/game.service";
import { doJoin, doLeave, doList } from "./game-actions";
import { advanceCreateWizard, advanceEditWizard, questionFor } from "./wizard";

/** ข้อมูลที่แนบมากับปุ่ม เป็น query string และต้อง validate ทุกครั้ง (spec §18) */
const postbackSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wizard"),
    pending_id: z.uuid(),
    // field = เลือกว่าจะแก้อะไร (เฉพาะตอนแก้ไขรอบ) ที่เหลือคือค่าที่เลือกมา
    step: z.enum(["field", "court", "max", "date", "time", "duration", "location", "promptpay"]),
    value: z.string().min(1).max(40),
  }),
  z.object({ action: z.literal("confirm"), pending_id: z.uuid() }),
  z.object({ action: z.literal("reject"), pending_id: z.uuid() }),
  // ปุ่มบนการ์ดรอบตี ทำกับรอบที่เปิดอยู่ของกลุ่มนั้น ไม่ต้องอ้างรอบ
  z.object({ action: z.literal("join") }),
  z.object({ action: z.literal("leave") }),
  z.object({ action: z.literal("list") }),
]);

export type PostbackParams = { date?: string; time?: string };
export type PostbackData = z.infer<typeof postbackSchema>;

type DraftStep = "court" | "max" | "date" | "time" | "duration";

export function parsePostbackData(data: string): PostbackData | null {
  const parsed = postbackSchema.safeParse(Object.fromEntries(new URLSearchParams(data)));
  return parsed.success ? parsed.data : null;
}

/** แปลงค่าที่กดมาเป็นค่าที่จะเก็บลง payload */
function draftValue(
  step: DraftStep,
  value: string,
  params: PostbackParams,
  today: string,
): { field: string; value: number | string } {
  switch (step) {
    case "court": {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 1 || count > 4) throw new AppError("INTERNAL_ERROR");
      return { field: "court_count", value: count };
    }
    case "max": {
      const count = Number(value);
      if (!Number.isInteger(count) || count < MIN_PLAYERS || count > MAX_PLAYERS) {
        throw new AppError("INTERNAL_ERROR");
      }
      return { field: "max_players", value: count };
    }
    case "date": {
      const date =
        value === "today" ? today : value === "tomorrow" ? addDays(today, 1) : (params.date ?? "");
      if (!DATE_PATTERN.test(date)) throw new AppError("INTERNAL_ERROR");
      return { field: "play_date", value: date };
    }
    case "time": {
      const time = value === "picker" ? (params.time ?? "") : value;
      if (!TIME_PATTERN.test(time)) throw new AppError("INTERNAL_ERROR");
      return { field: "start_time", value: time };
    }
    case "duration": {
      const minutes = Number(value);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes % 60 !== 0) {
        throw new AppError("INTERNAL_ERROR");
      }
      return { field: "duration_minutes", value: minutes };
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
  user: UserRow,
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
      return [gameCard(game, joinedCount, "✏️ แก้ไขรอบเรียบร้อย")];
    }
    case "cancel_game": {
      await applyCancelGame(pending.id, lineGroupId, userId);
      return [gameCancelled()];
    }
    case "close_game": {
      await applyCloseGame(pending.id, lineGroupId, userId);
      return [gameClosed()];
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

/**
 * จัดการปุ่มที่ผู้ใช้กด
 * ทุกปุ่มที่อ้าง pending action ต้องเป็นของคนที่สั่งเท่านั้น และใช้ได้เฉพาะที่ยังไม่หมดอายุ (spec §21)
 */
export async function handlePostback(
  parsed: PostbackData,
  input: {
    params: PostbackParams;
    lineGroupId: string;
    user: UserRow;
  },
): Promise<LineMessage[]> {
  const userId = input.user.id;

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

  if (parsed.step === "location") {
    // ปุ่มข้าม: เปิดรอบต่อโดยไม่มีแผนที่ ส่วนตอนแก้ไขคือไม่เปลี่ยนอะไร
    if (parsed.value !== "skip") throw new AppError("INTERNAL_ERROR");
    if (pending.action_type === "edit_game") {
      await expirePendingAction(pending.id, input.lineGroupId);
      return [actionRejected(pending.action_type)];
    }
    return advanceCreateWizard(pending, { location_asked: true });
  }

  const { field, value } = draftValue(parsed.step, parsed.value, input.params, todayInBangkok());

  if (pending.action_type === "edit_game") {
    return advanceEditWizard(pending.id, input.lineGroupId, field, value);
  }

  return advanceCreateWizard(pending, { [field]: value });
}

import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { addDays, DATE_PATTERN, TIME_PATTERN, todayInBangkok } from "@/lib/time";
import {
  actionRejected,
  askCourtCount,
  askDate,
  askDuration,
  askTime,
  confirmCreateGame,
  confirmEditGame,
  gameCancelled,
  gameCard,
  gameClosed,
  wizardPrompt,
} from "@/line/messages";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import {
  expirePendingAction,
  findUsablePendingAction,
  updatePendingPayload,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import type { UserRow } from "@/repositories/types";
import {
  applyCancelGame,
  applyCloseGame,
  applyEditGame,
  editPatchSchema,
  validatePatch,
} from "@/services/game-admin.service";
import {
  confirmCreateGame as confirmCreateGameService,
  gameDraftSchema,
  missingDraftFields,
} from "@/services/game.service";
import { doJoin, doLeave, doList } from "./game-actions";

/** ข้อมูลที่แนบมากับปุ่ม เป็น query string และต้อง validate ทุกครั้ง (spec §18) */
const postbackSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wizard"),
    pending_id: z.uuid(),
    // field = เลือกว่าจะแก้อะไร (เฉพาะตอนแก้ไขรอบ) ที่เหลือคือค่าที่เลือกมา
    step: z.enum(["field", "court", "date", "time", "duration"]),
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

type DraftStep = "court" | "date" | "time" | "duration";

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

/** คำถามของแต่ละช่อง ใช้ทั้งตอนเปิดรอบและตอนแก้ไข */
function questionFor(step: string, pendingId: string): LineMessage {
  switch (step) {
    case "court":
      return askCourtCount(pendingId);
    case "date":
      return askDate(pendingId);
    case "time":
      return askTime(pendingId);
    case "duration":
      return askDuration(pendingId);
    default:
      throw new AppError("INTERNAL_ERROR");
  }
}

async function handleConfirm(
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

/** แก้ไขทีละช่อง เลือกค่าเสร็จก็ไปการ์ดยืนยันเลย */
async function handleEditStep(
  pending: PendingActionRow,
  lineGroupId: string,
  field: string,
  value: number | string,
): Promise<LineMessage[]> {
  const patch = editPatchSchema.parse({ [field]: value });

  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");

  // ตรวจตั้งแต่ตอนนี้ จะได้ไม่ให้กดยืนยันไปแล้วค่อยบอกว่าไม่ได้
  validatePatch(game, patch, await countJoinedPlayers(game.id));

  const updated = await updatePendingPayload(pending.id, { [field]: value });
  if (!updated) throw new AppError("PENDING_EXPIRED");

  return [confirmEditGame(pending.id, game, patch)];
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
    return handleConfirm(pending, input.lineGroupId, userId);
  }

  if (parsed.step === "field") {
    if (pending.action_type !== "edit_game") throw new AppError("INTERNAL_ERROR");
    return [questionFor(parsed.value, pending.id)];
  }

  const { field, value } = draftValue(parsed.step, parsed.value, input.params, todayInBangkok());

  if (pending.action_type === "edit_game") {
    return handleEditStep(pending, input.lineGroupId, field, value);
  }

  const payload = { ...pending.payload, [field]: value };
  const updated = await updatePendingPayload(pending.id, payload);
  if (!updated) throw new AppError("PENDING_EXPIRED");

  const missing = missingDraftFields(payload);
  if (missing.length > 0) return [wizardPrompt(pending.id, payload, missing)];

  return [confirmCreateGame(pending.id, gameDraftSchema.parse(payload))];
}

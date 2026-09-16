import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { addDays, DATE_PATTERN, TIME_PATTERN, todayInBangkok } from "@/lib/time";
import { confirmCreateGame, gameCreated, text, wizardPrompt } from "@/line/messages";
import {
  expirePendingAction,
  findUsablePendingAction,
  updatePendingPayload,
} from "@/repositories/pending-action.repository";
import {
  confirmCreateGame as confirmCreateGameService,
  gameDraftSchema,
  missingDraftFields,
} from "@/services/game.service";

/** ข้อมูลที่แนบมากับปุ่ม เป็น query string และต้อง validate ทุกครั้ง (spec §18) */
const postbackSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("wizard"),
    pending_id: z.uuid(),
    step: z.enum(["court", "date", "time", "duration"]),
    value: z.string().min(1).max(40),
  }),
  z.object({ action: z.literal("confirm"), pending_id: z.uuid() }),
  z.object({ action: z.literal("reject"), pending_id: z.uuid() }),
]);

export type PostbackParams = { date?: string; time?: string };
export type PostbackData = z.infer<typeof postbackSchema>;

export function parsePostbackData(data: string): PostbackData | null {
  const parsed = postbackSchema.safeParse(Object.fromEntries(new URLSearchParams(data)));
  return parsed.success ? parsed.data : null;
}

/** แปลงค่าที่กดมาเป็นค่าที่จะเก็บลง payload */
function draftValue(
  step: "court" | "date" | "time" | "duration",
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

/**
 * จัดการปุ่มที่ผู้ใช้กด
 * ทุกปุ่มต้องเป็นของคนที่สั่งเท่านั้น และใช้ได้เฉพาะรายการที่ยังไม่หมดอายุ (spec §21)
 */
export async function handlePostback(
  parsed: PostbackData,
  input: {
    params: PostbackParams;
    lineGroupId: string;
    userId: string;
  },
): Promise<LineMessage[]> {
  if (parsed.action === "reject") {
    const pending = await findUsablePendingAction(parsed.pending_id, input.lineGroupId);
    if (!pending) throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== input.userId) throw new AppError("NOT_REQUESTER");

    await expirePendingAction(parsed.pending_id, input.lineGroupId);
    return [text("ยกเลิกแล้ว ไม่ได้เปิดรอบตีนะ")];
  }

  if (parsed.action === "confirm") {
    const game = await confirmCreateGameService(parsed.pending_id, input.lineGroupId, input.userId);
    return [gameCreated(game)];
  }

  const pending = await findUsablePendingAction(parsed.pending_id, input.lineGroupId);
  if (!pending) throw new AppError("PENDING_EXPIRED");
  if (pending.requested_by !== input.userId) throw new AppError("NOT_REQUESTER");

  const { field, value } = draftValue(parsed.step, parsed.value, input.params, todayInBangkok());
  const payload = { ...pending.payload, [field]: value };

  const updated = await updatePendingPayload(parsed.pending_id, payload);
  if (!updated) throw new AppError("PENDING_EXPIRED");

  const missing = missingDraftFields(payload);
  if (missing.length > 0) return [wizardPrompt(parsed.pending_id, payload, missing)];

  const draft = gameDraftSchema.parse(payload);
  return [confirmCreateGame(parsed.pending_id, draft)];
}

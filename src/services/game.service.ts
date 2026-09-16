import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql } from "@/lib/db";
import { DATE_PATTERN, isInThePast, TIME_PATTERN } from "@/lib/time";
import {
  consumePendingAction,
  createPendingAction,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import { findOpenGame, insertGame, UNIQUE_VIOLATION } from "@/repositories/game.repository";
import type { GameRow } from "@/repositories/types";

/** ข้อมูลที่ต้องครบก่อนเปิดรอบได้ เรียงตามลำดับที่ wizard ถาม */
export const DRAFT_FIELDS = ["court_count", "play_date", "start_time", "duration_minutes"] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

export const gameDraftSchema = z.object({
  court_count: z.number().int().min(1).max(4),
  play_date: z.string().regex(DATE_PATTERN),
  start_time: z.string().regex(TIME_PATTERN),
  duration_minutes: z.number().int().positive().multipleOf(60),
});

export type GameDraft = z.infer<typeof gameDraftSchema>;

/** ช่องที่ยังขาด เรียงตามลำดับคำถาม */
export function missingDraftFields(payload: Record<string, unknown>): DraftField[] {
  return DRAFT_FIELDS.filter((field) => {
    const single = gameDraftSchema.shape[field];
    return !single.safeParse(payload[field]).success;
  });
}

/** เริ่ม wizard เปิดรอบ ถ้ากลุ่มมีรอบเปิดอยู่แล้วต้องไม่ให้เริ่ม (spec §7) */
export async function startCreateGame(
  lineGroupId: string,
  userId: string,
): Promise<PendingActionRow> {
  const open = await findOpenGame(lineGroupId);
  if (open) throw new AppError("GAME_ALREADY_OPEN", { game: open });

  return createPendingAction({
    lineGroupId,
    requestedBy: userId,
    actionType: "create_game",
    payload: {},
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * ยืนยันเปิดรอบ ทำในทรานแซกชันเดียว: ใช้ pending action + สร้างรอบ
 * ถ้าสร้างไม่สำเร็จ pending action จะกลับมาใช้ได้เหมือนเดิม
 */
export async function confirmCreateGame(
  pendingId: string,
  lineGroupId: string,
  userId: string,
): Promise<GameRow> {
  return getSql().begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending) throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

    const parsed = gameDraftSchema.safeParse(pending.payload);
    if (!parsed.success) {
      throw new AppError("MISSING_FIELDS", { missing: missingDraftFields(pending.payload) });
    }

    const draft = parsed.data;
    if (isInThePast(draft.play_date, draft.start_time)) throw new AppError("DATE_IN_PAST");

    try {
      return await insertGame(
        {
          lineGroupId,
          createdBy: userId,
          playDate: draft.play_date,
          startTime: draft.start_time,
          durationMinutes: draft.duration_minutes,
          courtCount: draft.court_count,
        },
        tx,
      );
    } catch (error) {
      // มีคนเปิดรอบตัดหน้าไปแล้ว ระหว่างที่การ์ดยืนยันค้างอยู่
      if (isUniqueViolation(error)) throw new AppError("GAME_ALREADY_OPEN");
      throw error;
    }
  }) as Promise<GameRow>;
}

import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql, type Queryable, type Sql } from "@/lib/db";
import { DATE_PATTERN, isInThePast, TIME_PATTERN } from "@/lib/time";
import {
  consumePendingAction,
  createPendingAction,
  type PendingActionRow,
} from "@/repositories/pending-action.repository";
import { insertGame, listOpenGames, lockGroup } from "@/repositories/game.repository";
import type { GameRow } from "@/repositories/types";
import { MAX_OPEN_GAMES } from "./round.service";

/**
 * ข้อมูลที่ต้องถามก่อนเปิดรอบได้ เรียงตามลำดับที่ wizard ถาม
 *
 * max_players ไม่อยู่ในนี้ เพราะคิดจากจำนวนคอร์ทได้เอง (คอร์ท x 8) และแทบไม่มีใครเปลี่ยน
 * ใครอยากปรับจำนวนคนสั่ง "บอทจ๋า แก้ไข" ได้ตลอด
 */
export const DRAFT_FIELDS = [
  "court_count",
  "play_date",
  "start_time",
  "duration_minutes",
  "court_name",
] as const;
export type DraftField = (typeof DRAFT_FIELDS)[number];

/** ขอบเขตจำนวนคน ตรงกับ CHECK ในฐานข้อมูล (migration 006) */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 64;
export const COURT_NAME_MAX_LENGTH = 60;
export const LOCATION_URL_MAX_LENGTH = 500;

export const courtNameSchema = z.string().trim().min(1).max(COURT_NAME_MAX_LENGTH);
export const locationUrlSchema = z.url().max(LOCATION_URL_MAX_LENGTH);

/** เบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก ตรงกับ CHECK ในฐานข้อมูล (migration 007) */
export const PROMPTPAY_PATTERN = /^(\d{10}|\d{13})$/;

/**
 * คนพิมพ์เลขพร้อมเพย์มาได้สารพัดแบบ (มีขีด มีเว้นวรรค ก็อปมาจากที่อื่น)
 * เก็บเป็นตัวเลขล้วนเสมอ จะได้เทียบและแสดงผลได้แบบเดียวกันทุกที่
 */
export const promptPaySchema = z
  .string()
  .max(40)
  .transform((value) => value.replace(/\D/g, ""))
  .refine((digits) => PROMPTPAY_PATTERN.test(digits));

export const gameDraftSchema = z.object({
  court_count: z.number().int().min(1).max(4),
  max_players: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
  play_date: z.string().regex(DATE_PATTERN),
  start_time: z.string().regex(TIME_PATTERN),
  duration_minutes: z.number().int().positive().multipleOf(60),
  court_name: courtNameSchema,
  // ลิงก์แผนที่ ใส่หรือไม่ใส่ก็ได้ (spec §9)
  location_url: locationUrlSchema.optional(),
  // เลขพร้อมเพย์สำหรับตอนคิดเงิน ใส่หรือไม่ใส่ก็ได้ (PRP bill-splitting §6)
  promptpay: promptPaySchema.optional(),
});

export type GameDraft = z.infer<typeof gameDraftSchema>;

/** จำนวนคนตั้งต้นของจำนวนคอร์ทนั้น (spec §7) */
export function defaultMaxPlayers(courtCount: number): number {
  return courtCount * 8;
}

/** ช่องที่ยังขาด เรียงตามลำดับคำถาม */
export function missingDraftFields(payload: Record<string, unknown>): DraftField[] {
  return DRAFT_FIELDS.filter((field) => {
    const single = gameDraftSchema.shape[field];
    return !single.safeParse(payload[field]).success;
  });
}

/** กลุ่มเปิดรอบพร้อมกันได้ไม่เกิน MAX_OPEN_GAMES รอบ ครบแล้วต้องปิดหรือยกเลิกรอบเดิมก่อน (PRP multi-open-rounds §4.2) */
export async function requireRoomForGame(lineGroupId: string, sql: Queryable = getSql()): Promise<void> {
  const open = await listOpenGames(lineGroupId, sql);
  if (open.length >= MAX_OPEN_GAMES) throw new AppError("GAME_LIMIT_REACHED", { games: open });
}

/** เริ่ม wizard เปิดรอบ เช็กโควตาตั้งแต่ตอนนี้ จะได้ไม่ให้ตอบครบทุกคำถามแล้วค่อยบอกว่าเปิดไม่ได้ */
export async function startCreateGame(
  lineGroupId: string,
  userId: string,
): Promise<PendingActionRow> {
  await requireRoomForGame(lineGroupId);

  return createPendingAction({
    lineGroupId,
    requestedBy: userId,
    actionType: "create_game",
    payload: {},
  });
}

/**
 * ยืนยันเปิดรอบ ทำในทรานแซกชันเดียว: ใช้ pending action + สร้างรอบ
 * ถ้าสร้างไม่สำเร็จ pending action จะกลับมาใช้ได้เหมือนเดิม
 */
export async function confirmCreateGame(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<GameRow> {
  return sql.begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending) throw new AppError("PENDING_EXPIRED");
    if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

    const parsed = gameDraftSchema.safeParse(pending.payload);
    if (!parsed.success) {
      throw new AppError("MISSING_FIELDS", { missing: missingDraftFields(pending.payload) });
    }

    const draft = parsed.data;
    if (isInThePast(draft.play_date, draft.start_time)) throw new AppError("DATE_IN_PAST");

    // เช็กโควตาซ้ำ ระหว่างที่การ์ดค้างอยู่อาจมีคนเปิดรอบจนครบไปแล้ว
    // ล็อกกลุ่มก่อนนับ ไม่งั้นสองคนกดยืนยันพร้อมกันจะนับได้ไม่ครบทั้งคู่แล้วเปิดเกิน
    await lockGroup(lineGroupId, tx);
    await requireRoomForGame(lineGroupId, tx);

    return insertGame(
      {
        lineGroupId,
        createdBy: userId,
        playDate: draft.play_date,
        startTime: draft.start_time,
        durationMinutes: draft.duration_minutes,
        courtCount: draft.court_count,
        maxPlayers: draft.max_players,
        courtName: draft.court_name,
        locationUrl: draft.location_url ?? null,
        promptpay: draft.promptpay ?? null,
      },
      tx,
    );
  }) as Promise<GameRow>;
}

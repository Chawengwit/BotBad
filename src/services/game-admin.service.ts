import { z } from "zod";
import { AppError } from "@/errors/app-errors";
import { getSql, type Sql } from "@/lib/db";
import { DATE_PATTERN, isInThePast, TIME_PATTERN } from "@/lib/time";
import {
  courtNameSchema,
  locationUrlSchema,
  MAX_PLAYERS,
  MIN_PLAYERS,
} from "@/services/game.service";
import { countJoinedPlayers, findOpenGame, updateGame, updateGameStatus } from "@/repositories/game.repository";
import { lockOpenGame } from "@/repositories/player.repository";
import {
  consumePendingAction,
  createPendingAction,
  type PendingActionRow,
  type PendingActionType,
} from "@/repositories/pending-action.repository";
import type { GameRow } from "@/repositories/types";

/**
 * งานของเจ้าของรอบ: แก้ไข ยกเลิก ปิดรอบ (spec §15–§17)
 * ทุกอย่างต้องเป็นผู้สร้างรอบ และต้องกดยืนยันก่อนเสมอ
 */

export const editPatchSchema = z
  .object({
    court_count: z.number().int().min(1).max(4),
    max_players: z.number().int().min(MIN_PLAYERS).max(MAX_PLAYERS),
    play_date: z.string().regex(DATE_PATTERN),
    start_time: z.string().regex(TIME_PATTERN),
    duration_minutes: z.number().int().positive().multipleOf(60),
    court_name: courtNameSchema,
    location_url: locationUrlSchema,
  })
  .partial();

export type EditPatch = z.infer<typeof editPatchSchema>;

export type GameWithCount = {
  game: GameRow;
  joinedCount: number;
};

/** หา รอบที่เปิดอยู่ พร้อมตรวจว่าคนสั่งเป็นผู้สร้าง */
async function requireOwnedGame(lineGroupId: string, userId: string): Promise<GameWithCount> {
  const game = await findOpenGame(lineGroupId);
  if (!game) throw new AppError("NO_OPEN_GAME");
  if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");

  return { game, joinedCount: await countJoinedPlayers(game.id) };
}

async function startOwnerAction(
  lineGroupId: string,
  userId: string,
  actionType: PendingActionType,
): Promise<{ pending: PendingActionRow } & GameWithCount> {
  const owned = await requireOwnedGame(lineGroupId, userId);

  const pending = await createPendingAction({
    lineGroupId,
    requestedBy: userId,
    actionType,
    gameId: owned.game.id,
    payload: {},
  });

  return { pending, ...owned };
}

export function startEditGame(lineGroupId: string, userId: string) {
  return startOwnerAction(lineGroupId, userId, "edit_game");
}

export function startCancelGame(lineGroupId: string, userId: string) {
  return startOwnerAction(lineGroupId, userId, "cancel_game");
}

export function startCloseGame(lineGroupId: string, userId: string) {
  return startOwnerAction(lineGroupId, userId, "close_game");
}

/** ค่าที่จะเปลี่ยนต้องไม่ทำให้ที่นั่งไม่พอ และต้องไม่ย้อนอดีต (spec §15) */
export function validatePatch(game: GameRow, patch: EditPatch, joinedCount: number): void {
  if (Object.keys(patch).length === 0) throw new AppError("NO_CHANGES");

  // ลดจำนวนคนที่รับได้ต่ำกว่าคนที่ลงชื่อไว้แล้วไม่ได้ (spec §15)
  if (patch.max_players !== undefined && joinedCount > patch.max_players) {
    throw new AppError("MAX_PLAYERS_TOO_SMALL", {
      current_players: joinedCount,
      new_max_players: patch.max_players,
    });
  }

  // เปลี่ยนจำนวนคอร์ทไม่ได้ไปลดจำนวนคนอัตโนมัติแล้ว แต่ยังเตือนถ้าคอร์ทน้อยเกินกว่าคนที่ลงไว้มาก
  if (patch.court_count !== undefined) {
    const suggestedMax = patch.court_count * 8;
    if (joinedCount > suggestedMax) {
      throw new AppError("COURT_TOO_SMALL", {
        current_players: joinedCount,
        new_court_count: patch.court_count,
        new_max_players: suggestedMax,
      });
    }
  }

  const playDate = patch.play_date ?? game.play_date;
  const startTime = patch.start_time ?? game.start_time;
  if (isInThePast(playDate, startTime)) throw new AppError("DATE_IN_PAST");
}

function ensureOwner(pending: PendingActionRow, game: GameRow | null, userId: string): GameRow {
  if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");
  if (!game) throw new AppError("NO_OPEN_GAME");
  if (game.created_by !== userId) throw new AppError("NOT_GAME_CREATOR");
  return game;
}

/** ยืนยันการแก้ไข ตรวจซ้ำอีกรอบเพราะจำนวนคนอาจเปลี่ยนไปแล้ว */
export async function applyEditGame(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<GameWithCount> {
  return sql.begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending || pending.action_type !== "edit_game") throw new AppError("PENDING_EXPIRED");

    const game = ensureOwner(pending, await lockOpenGame(lineGroupId, tx), userId);

    const parsed = editPatchSchema.safeParse(pending.payload);
    if (!parsed.success) throw new AppError("NO_CHANGES");

    const joinedCount = await countJoinedPlayers(game.id, tx);
    validatePatch(game, parsed.data, joinedCount);

    const updated = await updateGame(
      game.id,
      {
        courtCount: parsed.data.court_count,
        // เปลี่ยนจำนวนคอร์ทแล้วยังไม่ได้ตั้งจำนวนคนใหม่ ให้ใช้ค่าปกติของคอร์ทนั้น
        maxPlayers:
          parsed.data.max_players ??
          (parsed.data.court_count !== undefined ? parsed.data.court_count * 8 : undefined),
        playDate: parsed.data.play_date,
        startTime: parsed.data.start_time,
        durationMinutes: parsed.data.duration_minutes,
        courtName: parsed.data.court_name,
        locationUrl: parsed.data.location_url,
      },
      tx,
    );

    return { game: updated, joinedCount };
  }) as Promise<GameWithCount>;
}

async function applyStatusChange(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  actionType: "cancel_game" | "close_game",
  status: "cancelled" | "completed",
  sql: Sql,
): Promise<GameWithCount> {
  return sql.begin(async (tx) => {
    const pending = await consumePendingAction(pendingId, lineGroupId, tx);
    if (!pending || pending.action_type !== actionType) throw new AppError("PENDING_EXPIRED");

    const game = ensureOwner(pending, await lockOpenGame(lineGroupId, tx), userId);
    const joinedCount = await countJoinedPlayers(game.id, tx);

    await updateGameStatus(game.id, status, tx);
    return { game, joinedCount };
  }) as Promise<GameWithCount>;
}

export function applyCancelGame(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<GameWithCount> {
  return applyStatusChange(pendingId, lineGroupId, userId, "cancel_game", "cancelled", sql);
}

export function applyCloseGame(
  pendingId: string,
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<GameWithCount> {
  return applyStatusChange(pendingId, lineGroupId, userId, "close_game", "completed", sql);
}

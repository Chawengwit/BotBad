import { AppError } from "@/errors/app-errors";
import { getSql, type Sql } from "@/lib/db";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import {
  cancelPlayer,
  findPlayerStatus,
  joinPlayer,
  listJoinedPlayers,
  lockOpenGame,
} from "@/repositories/player.repository";
import type { GamePlayerRow, GameRow } from "@/repositories/types";

export type PlayerCountResult = {
  game: GameRow;
  joinedCount: number;
};

/**
 * ลงชื่อเข้ารอบที่เปิดอยู่
 * ทำในทรานแซกชันที่ล็อกแถวรอบไว้ กันคนลงพร้อมกันจนเกินจำนวน (spec §20)
 */
export async function joinGame(
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<PlayerCountResult> {
  return sql.begin(async (tx) => {
    const game = await lockOpenGame(lineGroupId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    const status = await findPlayerStatus(game.id, userId, tx);
    if (status === "joined") throw new AppError("ALREADY_JOINED");

    const joinedCount = await countJoinedPlayers(game.id, tx);
    if (joinedCount >= game.max_players) {
      throw new AppError("GAME_FULL", {
        current_players: joinedCount,
        max_players: game.max_players,
      });
    }

    await joinPlayer(game.id, userId, tx);
    return { game, joinedCount: joinedCount + 1 };
  }) as Promise<PlayerCountResult>;
}

/** ถอนชื่อออกจากรอบที่เปิดอยู่ */
export async function leaveGame(
  lineGroupId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<PlayerCountResult> {
  return sql.begin(async (tx) => {
    const game = await lockOpenGame(lineGroupId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    const status = await findPlayerStatus(game.id, userId, tx);
    if (status !== "joined") throw new AppError("NOT_JOINED");

    await cancelPlayer(game.id, userId, tx);
    const joinedCount = await countJoinedPlayers(game.id, tx);
    return { game, joinedCount };
  }) as Promise<PlayerCountResult>;
}

export type GameWithPlayers = {
  game: GameRow;
  players: GamePlayerRow[];
};

export async function listPlayers(
  lineGroupId: string,
  sql: Sql = getSql(),
): Promise<GameWithPlayers> {
  const game = await findOpenGame(lineGroupId, sql);
  if (!game) throw new AppError("NO_OPEN_GAME");

  return { game, players: await listJoinedPlayers(game.id, sql) };
}

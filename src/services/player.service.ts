import { AppError } from "@/errors/app-errors";
import { getSql, type Sql } from "@/lib/db";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import {
  cancelPlayer,
  findAddedBy,
  findPlayerStatus,
  joinPlayer,
  listJoinedPlayers,
  lockOpenGame,
} from "@/repositories/player.repository";
import type { GamePlayerRow, GameRow, UserRow } from "@/repositories/types";

export type PlayerCountResult = {
  game: GameRow;
  joinedCount: number;
  /** จำนวนครั้งที่คนนี้เปลี่ยนใจในรอบนี้ ลงชื่อครั้งแรกคือ 0 */
  changeCount: number;
};

export type ProxyResult = {
  game: GameRow;
  joinedCount: number;
  /** คนที่ลงหรือถอนสำเร็จ เรียงตามที่พิมพ์มา */
  people: UserRow[];
  /** คนที่ทำไม่ได้ พร้อมเหตุผล เช่น ลงชื่อไว้แล้ว หรือไม่ใช่แขกของเรา */
  skipped: { user: UserRow; reason: "already_joined" | "not_joined" | "not_yours" }[];
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

    const changeCount = await joinPlayer(game.id, userId, tx);
    return { game, joinedCount: joinedCount + 1, changeCount };
  }) as Promise<PlayerCountResult>;
}

/**
 * ลงชื่อให้คนอื่น ทีละหลายคนในคำสั่งเดียว (PRP guests-split-bills-and-digest §4.6)
 *
 * ต้องอยู่ในทรานแซกชันเดียวกับการนับที่นั่ง ไม่งั้นสั่งลงสองคนตอนเหลือที่เดียว
 * จะผ่านทั้งคู่เพราะต่างคนต่างนับก่อนอีกคนเขียน
 */
export async function joinPeople(
  lineGroupId: string,
  people: UserRow[],
  addedBy: string,
  sql: Sql = getSql(),
): Promise<ProxyResult> {
  return sql.begin(async (tx) => {
    const game = await lockOpenGame(lineGroupId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    let joinedCount = await countJoinedPlayers(game.id, tx);
    const result: ProxyResult = { game, joinedCount, people: [], skipped: [] };

    for (const person of people) {
      const status = await findPlayerStatus(game.id, person.id, tx);
      if (status === "joined") {
        result.skipped.push({ user: person, reason: "already_joined" });
        continue;
      }

      if (joinedCount >= game.max_players) {
        throw new AppError("GAME_FULL", {
          current_players: joinedCount,
          max_players: game.max_players,
        });
      }

      await joinPlayer(game.id, person.id, tx, addedBy);
      joinedCount += 1;
      result.people.push(person);
    }

    result.joinedCount = joinedCount;
    return result;
  }) as Promise<ProxyResult>;
}

/**
 * ถอนชื่อให้คนอื่น ถอนได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้ (PRP §4.3)
 * ก๊วนเชื่อใจกันก็จริง แต่กดผิดแล้วคนหายจากรอบโดยไม่มีใครรู้ตัว
 */
export async function leavePeople(
  lineGroupId: string,
  people: UserRow[],
  actorId: string,
  sql: Sql = getSql(),
): Promise<ProxyResult> {
  return sql.begin(async (tx) => {
    const game = await lockOpenGame(lineGroupId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    const result: ProxyResult = { game, joinedCount: 0, people: [], skipped: [] };

    for (const person of people) {
      const status = await findPlayerStatus(game.id, person.id, tx);
      if (status !== "joined") {
        result.skipped.push({ user: person, reason: "not_joined" });
        continue;
      }

      const addedBy = await findAddedBy(game.id, person.id, tx);
      if (person.id !== actorId && addedBy !== actorId) {
        result.skipped.push({ user: person, reason: "not_yours" });
        continue;
      }

      await cancelPlayer(game.id, person.id, tx);
      result.people.push(person);
    }

    result.joinedCount = await countJoinedPlayers(game.id, tx);
    return result;
  }) as Promise<ProxyResult>;
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

    const changeCount = await cancelPlayer(game.id, userId, tx);
    const joinedCount = await countJoinedPlayers(game.id, tx);
    return { game, joinedCount, changeCount };
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

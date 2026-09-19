import { AppError } from "@/errors/app-errors";
import { getSql, type Sql } from "@/lib/db";
import { countJoinedPlayers, findGameById } from "@/repositories/game.repository";
import { consumePendingAction } from "@/repositories/pending-action.repository";
import {
  cancelPlayer,
  findPlayerStatus,
  joinPlayer,
  listJoinedPlayers,
  lockGame,
} from "@/repositories/player.repository";
import { findUsersByIds } from "@/repositories/user.repository";
import type { GameRow, UserRow } from "@/repositories/types";
import type { Round } from "./round.service";

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
 * ลงชื่อเข้ารอบที่เลือก
 * ทำในทรานแซกชันที่ล็อกแถวรอบไว้ กันคนลงพร้อมกันจนเกินจำนวน (spec §20)
 */
export async function joinGame(
  lineGroupId: string,
  gameId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<PlayerCountResult> {
  return sql.begin(async (tx) => {
    const game = await lockGame(lineGroupId, gameId, tx);
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
  gameId: string,
  people: UserRow[],
  addedBy: string,
  sql: Sql = getSql(),
): Promise<ProxyResult> {
  return sql.begin(async (tx) => {
    const game = await lockGame(lineGroupId, gameId, tx);
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
 * ถอนคนนี้ออกจากรอบนี้ได้ไหม: ต้องอยู่ในรายชื่อ และคนสั่งต้องเป็นเจ้าตัวหรือคนที่ลงชื่อให้ (PRP §4.3)
 * ก๊วนเชื่อใจกันก็จริง แต่กดผิดแล้วคนหายจากรอบโดยไม่มีใครรู้ตัว
 * กติกาเดียวใช้ทั้งตอนเลือกรอบ ตอนขึ้นการ์ดยืนยัน และตอนถอนจริง
 */
export function leaveBlock(round: Round, person: UserRow, actorId: string): "not_joined" | "not_yours" | null {
  const player = round.players.find((entry) => entry.user_id === person.id);
  if (!player) return "not_joined";
  if (person.id !== actorId && player.added_by !== actorId) return "not_yours";
  return null;
}

/** ถอนชื่อให้คนอื่น ถอนได้เฉพาะคนที่อยู่ในรายชื่อรอบนี้ และเป็นเจ้าตัวหรือคนที่ลงชื่อให้ */
export async function leavePeople(
  lineGroupId: string,
  gameId: string,
  people: UserRow[],
  actorId: string,
  sql: Sql = getSql(),
): Promise<ProxyResult> {
  return sql.begin(async (tx) => {
    const game = await lockGame(lineGroupId, gameId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    // อ่านรายชื่อหลังล็อกแล้ว สิทธิ์จะได้เช็กจากรายชื่อล่าสุดเสมอ
    const round: Round = { game, players: await listJoinedPlayers(game.id, tx) };
    const result: ProxyResult = { game, joinedCount: 0, people: [], skipped: [] };

    for (const person of people) {
      const block = leaveBlock(round, person, actorId);
      if (block) {
        result.skipped.push({ user: person, reason: block });
        continue;
      }

      await cancelPlayer(game.id, person.id, tx);
      result.people.push(person);
    }

    result.joinedCount = await countJoinedPlayers(game.id, tx);
    return result;
  }) as Promise<ProxyResult>;
}

export type LeavePlan = {
  game: GameRow;
  /** คนที่ถอนได้จริงตอนนี้ */
  removable: UserRow[];
  skipped: ProxyResult["skipped"];
};

/**
 * เช็กก่อนว่าใครถอนได้จริง ยังไม่แตะรายชื่อ
 * ใช้ก่อนขึ้นการ์ดยืนยัน จะได้ไม่ขึ้นปุ่มให้คนที่ไม่อยู่ในรายชื่อหรือถอนไม่ได้อยู่แล้ว
 */
export function planLeave(round: Round, people: UserRow[], actorId: string): LeavePlan {
  const plan: LeavePlan = { game: round.game, removable: [], skipped: [] };
  for (const person of people) {
    const block = leaveBlock(round, person, actorId);
    if (block) {
      plan.skipped.push({ user: person, reason: block });
      continue;
    }
    plan.removable.push(person);
  }
  return plan;
}

/**
 * กดยืนยันบนการ์ดถอนชื่อ ใช้ปุ่มทิ้งก่อนถอน กดซ้ำหรือกดพร้อมกันจะถอนได้ครั้งเดียว
 * ระหว่างรอกด รายชื่ออาจเปลี่ยนไปแล้ว จึงเช็กสิทธิ์ใหม่ทั้งหมดตอนถอนจริง
 */
export async function confirmLeavePlayers(
  pendingId: string,
  lineGroupId: string,
  userId: string,
): Promise<ProxyResult> {
  const pending = await consumePendingAction(pendingId, lineGroupId, getSql());
  if (!pending || pending.action_type !== "leave_players") throw new AppError("PENDING_EXPIRED");
  if (pending.requested_by !== userId) throw new AppError("NOT_REQUESTER");

  // การ์ดใบนี้ออกไว้กับรอบไหน ถอนจากรอบนั้นเท่านั้น รอบถูกปิดหรือยกเลิกไปแล้วกดแล้วไม่มีผล
  const game = pending.game_id ? await findGameById(pending.game_id) : null;
  if (!game || game.status !== "open") throw new AppError("PENDING_EXPIRED");

  const people = await findUsersByIds((pending.payload.user_ids ?? []) as string[]);
  return leavePeople(lineGroupId, game.id, people, userId);
}

/** ถอนชื่อออกจากรอบที่เลือก */
export async function leaveGame(
  lineGroupId: string,
  gameId: string,
  userId: string,
  sql: Sql = getSql(),
): Promise<PlayerCountResult> {
  return sql.begin(async (tx) => {
    const game = await lockGame(lineGroupId, gameId, tx);
    if (!game) throw new AppError("NO_OPEN_GAME");

    const status = await findPlayerStatus(game.id, userId, tx);
    if (status !== "joined") throw new AppError("NOT_JOINED");

    const changeCount = await cancelPlayer(game.id, userId, tx);
    const joinedCount = await countJoinedPlayers(game.id, tx);
    return { game, joinedCount, changeCount };
  }) as Promise<PlayerCountResult>;
}

import { AppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import {
  joinedForNotice,
  joinedNotice,
  leftForNotice,
  leftNotice,
  NAG_AFTER_CHANGES,
  nagFlipFlop,
  playerList,
} from "@/line/messages";
import { upsertGuest } from "@/repositories/user.repository";
import type { LineUserRow } from "@/repositories/types";
import { parseNames, resolvePeople } from "@/services/people.service";
import { joinGame, joinPeople, leaveGame, leavePeople, listPlayers } from "@/services/player.service";

/**
 * งานที่เรียกได้ทั้งจากปุ่มบนการ์ดและจากคำสั่งพิมพ์
 * รวมไว้ที่เดียวเพื่อให้สองทางเข้าตอบเหมือนกันเสมอ
 */

/** เปลี่ยนใจกลับไปกลับมาหลายรอบ บอทจะแซวต่อท้ายให้ */
function withNag(
  messages: LineMessage[],
  displayName: string,
  changeCount: number,
): LineMessage[] {
  if (changeCount < NAG_AFTER_CHANGES) return messages;
  return [...messages, nagFlipFlop(displayName, changeCount)];
}

export async function doJoin(lineGroupId: string, user: LineUserRow): Promise<LineMessage[]> {
  const { game, joinedCount, changeCount } = await joinGame(lineGroupId, user.id);
  return withNag(
    [joinedNotice(user.display_name, joinedCount, game.max_players)],
    user.display_name,
    changeCount,
  );
}

export async function doLeave(lineGroupId: string, user: LineUserRow): Promise<LineMessage[]> {
  const { game, joinedCount, changeCount } = await leaveGame(lineGroupId, user.id);
  return withNag(
    [leftNotice(user.display_name, joinedCount, game.max_players)],
    user.display_name,
    changeCount,
  );
}

/**
 * ลงชื่อให้คนอื่น รวมถึงแขกที่ไม่ได้อยู่ในกลุ่ม (PRP guests-split-bills-and-digest §4)
 * ชื่อที่ไม่รู้จักถือว่าเป็นแขกใหม่ที่คนสั่งพามาเอง จึงสร้างให้เลยโดยไม่ต้องถามซ้ำ
 * แต่ต้องประกาศในข้อความว่าเพิ่งเพิ่มใครเข้ามาใหม่ (§4.7)
 */
export async function doJoinFor(
  lineGroupId: string,
  user: LineUserRow,
  args: string,
): Promise<LineMessage[]> {
  const names = parseNames(args);
  if (names.length === 0) return doJoin(lineGroupId, user);

  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });

  const guests = await Promise.all(unknown.map((name) => upsertGuest(lineGroupId, name)));
  const result = await joinPeople(lineGroupId, [...people, ...guests], user.id);

  return [
    joinedForNotice(user.display_name, result, guests.map((guest) => guest.display_name)),
  ];
}

/** ถอนชื่อให้คนอื่น ได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้ (PRP §4.3) */
export async function doLeaveFor(
  lineGroupId: string,
  user: LineUserRow,
  args: string,
): Promise<LineMessage[]> {
  const names = parseNames(args);
  if (names.length === 0) return doLeave(lineGroupId, user);

  const { people, unknown, ambiguous } = await resolvePeople(lineGroupId, names, user);
  if (ambiguous.length > 0) throw new AppError("PERSON_AMBIGUOUS", { names: ambiguous });
  // ถอนชื่อคนที่ระบบไม่รู้จักไม่ได้ ต่างจากลงชื่อที่สร้างแขกใหม่ให้
  if (people.length === 0) throw new AppError("PERSON_NOT_FOUND", { names: unknown });

  const result = await leavePeople(lineGroupId, people, user.id);
  return [leftForNotice(user.display_name, result, unknown)];
}

/** ขอรายชื่อก็ได้รายชื่อ ไม่ต้องแถการ์ดรอบตีซ้ำอีกใบ (spec §23) */
export async function doList(lineGroupId: string): Promise<LineMessage[]> {
  const { game, players } = await listPlayers(lineGroupId);
  return [playerList(game, players)];
}

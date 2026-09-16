import type { LineMessage } from "@/lib/line";
import { gameCard, NAG_AFTER_CHANGES, nagFlipFlop, playerList } from "@/line/messages";
import type { UserRow } from "@/repositories/types";
import { joinGame, leaveGame, listPlayers } from "@/services/player.service";

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

export async function doJoin(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { game, joinedCount, changeCount } = await joinGame(lineGroupId, user.id);
  return withNag(
    [gameCard(game, joinedCount, `✅ ${user.display_name} ลงชื่อแล้ว`)],
    user.display_name,
    changeCount,
  );
}

export async function doLeave(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { game, joinedCount, changeCount } = await leaveGame(lineGroupId, user.id);
  return withNag(
    [gameCard(game, joinedCount, `👋 ${user.display_name} ถอนชื่อแล้ว`)],
    user.display_name,
    changeCount,
  );
}

export async function doList(lineGroupId: string): Promise<LineMessage[]> {
  const { game, players } = await listPlayers(lineGroupId);
  return [playerList(game, players), gameCard(game, players.length, "ทำอะไรต่อดี?")];
}

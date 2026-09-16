import type { LineMessage } from "@/lib/line";
import { gameCard, playerList } from "@/line/messages";
import type { UserRow } from "@/repositories/types";
import { joinGame, leaveGame, listPlayers } from "@/services/player.service";

/**
 * งานที่เรียกได้ทั้งจากปุ่มบนการ์ดและจากคำสั่งพิมพ์
 * รวมไว้ที่เดียวเพื่อให้สองทางเข้าตอบเหมือนกันเสมอ
 */

export async function doJoin(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { game, joinedCount } = await joinGame(lineGroupId, user.id);
  return [gameCard(game, joinedCount, `✅ ${user.display_name} ลงชื่อแล้ว`)];
}

export async function doLeave(lineGroupId: string, user: UserRow): Promise<LineMessage[]> {
  const { game, joinedCount } = await leaveGame(lineGroupId, user.id);
  return [gameCard(game, joinedCount, `👋 ${user.display_name} ถอนชื่อแล้ว`)];
}

export async function doList(lineGroupId: string): Promise<LineMessage[]> {
  const { game, players } = await listPlayers(lineGroupId);
  return [playerList(game, players), gameCard(game, players.length, "ทำอะไรต่อดี?")];
}

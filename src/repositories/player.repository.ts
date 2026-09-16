import { getSql, type Queryable } from "@/lib/db";
import type { GamePlayerRow, GameRow } from "./types";

/**
 * ล็อกแถวรอบตีไว้ก่อนนับจำนวนคน
 * จำเป็นเพราะหลายคนกดลงชื่อพร้อมกันได้ (spec §20)
 */
export async function lockOpenGame(
  lineGroupId: string,
  sql: Queryable,
): Promise<GameRow | null> {
  const rows = await sql<GameRow[]>`
    SELECT id,
           line_group_id,
           created_by,
           to_char(play_date, 'YYYY-MM-DD') AS play_date,
           to_char(start_time, 'HH24:MI') AS start_time,
           duration_minutes,
           court_count,
           max_players,
           status,
           court_name,
           location_url,
           promptpay,
           edit_count
    FROM games
    WHERE line_group_id = ${lineGroupId} AND status = 'open'
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function findPlayerStatus(
  gameId: string,
  userId: string,
  sql: Queryable = getSql(),
): Promise<"joined" | "cancelled" | null> {
  const rows = await sql<{ status: "joined" | "cancelled" }[]>`
    SELECT status FROM game_players
    WHERE game_id = ${gameId} AND user_id = ${userId}
  `;
  return rows[0]?.status ?? null;
}

/**
 * ลงชื่อ หรือกลับเข้ามาใหม่หลังเคยถอนชื่อ
 * คืนจำนวนครั้งที่คนนี้เปลี่ยนใจในรอบนี้ (ลงครั้งแรกคือ 0)
 */
export async function joinPlayer(
  gameId: string,
  userId: string,
  sql: Queryable,
): Promise<number> {
  const rows = await sql<{ change_count: number }[]>`
    INSERT INTO game_players (game_id, user_id, status)
    VALUES (${gameId}, ${userId}, 'joined')
    ON CONFLICT (game_id, user_id) DO UPDATE
      SET status = 'joined',
          joined_at = now(),
          change_count = game_players.change_count + 1,
          updated_at = now()
    RETURNING change_count
  `;
  return rows[0]?.change_count ?? 0;
}

export async function cancelPlayer(
  gameId: string,
  userId: string,
  sql: Queryable,
): Promise<number> {
  const rows = await sql<{ change_count: number }[]>`
    UPDATE game_players
    SET status = 'cancelled',
        change_count = change_count + 1,
        updated_at = now()
    WHERE game_id = ${gameId} AND user_id = ${userId}
    RETURNING change_count
  `;
  return rows[0]?.change_count ?? 0;
}

/** รายชื่อคนที่ลงชื่อไว้ เรียงตามลำดับที่ลงชื่อ (spec §14) */
export async function listJoinedPlayers(
  gameId: string,
  sql: Queryable = getSql(),
): Promise<GamePlayerRow[]> {
  return sql<GamePlayerRow[]>`
    SELECT gp.id, gp.game_id, gp.user_id, gp.status, u.display_name
    FROM game_players gp
    JOIN users u ON u.id = gp.user_id
    WHERE gp.game_id = ${gameId} AND gp.status = 'joined'
    ORDER BY gp.joined_at, gp.id
  `;
}

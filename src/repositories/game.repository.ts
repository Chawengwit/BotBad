import { getSql, type Queryable } from "@/lib/db";
import type { GameRow } from "./types";

// play_date เป็น DATE และ start_time เป็น TIME ถ้าปล่อยให้ driver แปลงเองจะเพี้ยนตาม timezone
// จึงดึงออกมาเป็นข้อความตรง ๆ ทุก query (เขียนซ้ำดีกว่าเอา string มาต่อเป็น SQL)

export type NewGame = {
  lineGroupId: string;
  createdBy: string;
  playDate: string;
  startTime: string;
  durationMinutes: number;
  courtCount: number;
};

/** รอบที่ยังเปิดอยู่ของกลุ่ม มีได้มากสุด 1 รอบ (spec §7) */
export async function findOpenGame(
  lineGroupId: string,
  sql: Queryable = getSql(),
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
           status
    FROM games
    WHERE line_group_id = ${lineGroupId} AND status = 'open'
  `;
  return rows[0] ?? null;
}

export async function insertGame(game: NewGame, sql: Queryable = getSql()): Promise<GameRow> {
  const rows = await sql<GameRow[]>`
    INSERT INTO games (
      line_group_id, created_by, play_date, start_time,
      duration_minutes, court_count, max_players
    )
    VALUES (
      ${game.lineGroupId},
      ${game.createdBy},
      ${game.playDate}::date,
      ${game.startTime}::time,
      ${game.durationMinutes},
      ${game.courtCount},
      ${game.courtCount * 8}
    )
    RETURNING id,
              line_group_id,
              created_by,
              to_char(play_date, 'YYYY-MM-DD') AS play_date,
              to_char(start_time, 'HH24:MI') AS start_time,
              duration_minutes,
              court_count,
              max_players,
              status
  `;

  const created = rows[0];
  if (!created) throw new Error("insertGame returned no row");
  return created;
}

export type GamePatch = {
  playDate?: string;
  startTime?: string;
  durationMinutes?: number;
  courtCount?: number;
};

/** แก้ไขรอบ ส่งเฉพาะช่องที่จะเปลี่ยน (spec §15) */
export async function updateGame(
  gameId: string,
  patch: GamePatch,
  sql: Queryable = getSql(),
): Promise<GameRow> {
  const rows = await sql<GameRow[]>`
    UPDATE games
    SET play_date = COALESCE(${patch.playDate ?? null}::date, play_date),
        start_time = COALESCE(${patch.startTime ?? null}::time, start_time),
        duration_minutes = COALESCE(${patch.durationMinutes ?? null}::int, duration_minutes),
        court_count = COALESCE(${patch.courtCount ?? null}::int, court_count),
        max_players = COALESCE(${patch.courtCount ?? null}::int * 8, max_players),
        updated_at = now()
    WHERE id = ${gameId}
    RETURNING id,
              line_group_id,
              created_by,
              to_char(play_date, 'YYYY-MM-DD') AS play_date,
              to_char(start_time, 'HH24:MI') AS start_time,
              duration_minutes,
              court_count,
              max_players,
              status
  `;

  const updated = rows[0];
  if (!updated) throw new Error("updateGame returned no row");
  return updated;
}

/** ปิดรอบ (completed) หรือยกเลิกรอบ (cancelled) */
export async function updateGameStatus(
  gameId: string,
  status: "cancelled" | "completed",
  sql: Queryable = getSql(),
): Promise<void> {
  await sql`
    UPDATE games
    SET status = ${status}, updated_at = now()
    WHERE id = ${gameId}
  `;
}

export async function countJoinedPlayers(gameId: string, sql: Queryable = getSql()): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM game_players
    WHERE game_id = ${gameId} AND status = 'joined'
  `;
  return rows[0]?.count ?? 0;
}

/** Postgres คืน code นี้เมื่อชน unique index เช่น เปิดรอบซ้อนในกลุ่มเดียวกัน */
export const UNIQUE_VIOLATION = "23505";

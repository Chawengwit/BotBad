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
  maxPlayers: number;
  courtName: string;
  locationUrl?: string | null;
  promptpay?: string | null;
};

/**
 * รอบที่ยังเปิดอยู่ของกลุ่ม เปิดพร้อมกันได้หลายรอบ (PRP multi-open-rounds)
 * เรียงตามวันเวลาเล่น ปุ่ม "รอบไหน?" กับรายชื่อทุกรอบจะได้เรียงเหมือนกันเสมอ
 */
export async function listOpenGames(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<GameRow[]> {
  return sql<GameRow[]>`
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
    ORDER BY play_date, start_time, id
  `;
}

/**
 * เกมที่ยังคิดค่ารอบได้: ยังเปิดอยู่ หรือปิดไปไม่เกิน 7 วัน ไม่รวมเกมที่ยกเลิก (PRP multi-open-rounds §5.1)
 * เวลาที่ปิดอ่านจาก updated_at เพราะเกมที่ปิดแล้วแก้ไขไม่ได้อีก ค่านี้จึงไม่ขยับหลังปิด
 */
export async function listBillableGames(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<GameRow[]> {
  return sql<GameRow[]>`
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
    WHERE line_group_id = ${lineGroupId}
      AND (status = 'open' OR (status = 'completed' AND updated_at > now() - interval '7 days'))
    ORDER BY play_date, start_time, id
  `;
}

/** รอบตีตาม id ใช้กับบิลที่ยังตามเก็บเงินอยู่หลังรอบปิดไปแล้ว */
export async function findGameById(
  gameId: string,
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
           status,
           court_name,
           location_url,
           promptpay,
           edit_count
    FROM games
    WHERE id = ${gameId}
  `;
  return rows[0] ?? null;
}

/**
 * เลขพร้อมเพย์ที่กลุ่มนี้ใช้ล่าสุด เอาไว้เสนอเป็นปุ่ม "ใช้อันเดิม"
 * จะได้ไม่ต้องพิมพ์ใหม่ทุกสัปดาห์ (PRP bill-splitting §6)
 */
export async function findLatestPromptPay(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<string | null> {
  const rows = await sql<{ promptpay: string }[]>`
    SELECT promptpay
    FROM games
    WHERE line_group_id = ${lineGroupId} AND promptpay IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0]?.promptpay ?? null;
}

export type LastVenue = {
  court_name: string;
  location_url: string | null;
  start_time: string;
};

/**
 * สนามและเวลาของรอบล่าสุดของกลุ่ม ใช้เสนอ "ที่เดิม เวลาเดิม" ตอนเปิดรอบใหม่
 * ก๊วนส่วนใหญ่ตีที่เดิมเวลาเดิมทุกสัปดาห์ จะได้ไม่ต้องพิมพ์ซ้ำทุกครั้ง
 * ดูทุกสถานะ เพราะรอบที่เพิ่งปิดไปคือรอบที่ใกล้เคียงที่สุดกับรอบถัดไป
 */
export async function findLatestVenue(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<LastVenue | null> {
  const rows = await sql<LastVenue[]>`
    SELECT court_name,
           location_url,
           to_char(start_time, 'HH24:MI') AS start_time
    FROM games
    WHERE line_group_id = ${lineGroupId} AND court_name IS NOT NULL
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function insertGame(game: NewGame, sql: Queryable = getSql()): Promise<GameRow> {
  const rows = await sql<GameRow[]>`
    INSERT INTO games (
      line_group_id, created_by, play_date, start_time,
      duration_minutes, court_count, max_players, court_name, location_url, promptpay
    )
    VALUES (
      ${game.lineGroupId},
      ${game.createdBy},
      ${game.playDate}::date,
      ${game.startTime}::time,
      ${game.durationMinutes},
      ${game.courtCount},
      ${game.maxPlayers},
      ${game.courtName},
      ${game.locationUrl ?? null},
      ${game.promptpay ?? null}
    )
    RETURNING id,
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
  maxPlayers?: number;
  courtName?: string;
  locationUrl?: string;
  promptpay?: string;
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
        max_players = COALESCE(${patch.maxPlayers ?? null}::int, max_players),
        court_name = COALESCE(${patch.courtName ?? null}::text, court_name),
        location_url = COALESCE(${patch.locationUrl ?? null}::text, location_url),
        promptpay = COALESCE(${patch.promptpay ?? null}::text, promptpay),
        edit_count = edit_count + 1,
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
              status,
              court_name,
              location_url,
              promptpay,
              edit_count
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

/**
 * ปิดรอบที่วันเล่นผ่านไปแล้วของทุกกลุ่ม คืนจำนวนรอบที่ปิด (PRP multi-open-rounds §5)
 * ตั้ง updated_at ด้วย เพราะเป็นเวลาที่ใช้นับ 7 วันที่ยังคิดค่ารอบได้
 */
export async function closeOverdueGames(today: string, sql: Queryable = getSql()): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    UPDATE games
    SET status = 'completed', updated_at = now()
    WHERE status = 'open' AND play_date < ${today}::date
    RETURNING id
  `;
  return rows.length;
}

/**
 * ล็อกกลุ่มไว้จนจบทรานแซกชัน ใช้ก่อนนับรอบตอนยืนยันเปิดรอบใหม่ (PRP multi-open-rounds §7)
 * ไม่มี unique index กันเปิดรอบซ้อนแล้ว ถ้าไม่ล็อก สองคนกดยืนยันพร้อมกันจะนับได้ 2 รอบทั้งคู่แล้วเปิดเป็น 4
 */
export async function lockGroup(lineGroupId: string, sql: Queryable): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${lineGroupId}))`;
}

export async function countJoinedPlayers(gameId: string, sql: Queryable = getSql()): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM game_players
    WHERE game_id = ${gameId} AND status = 'joined'
  `;
  return rows[0]?.count ?? 0;
}

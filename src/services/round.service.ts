import { AppError } from "@/errors/app-errors";
import { listOpenGames } from "@/repositories/game.repository";
import { listJoinedPlayersOf } from "@/repositories/player.repository";
import type { GamePlayerRow, GameRow } from "@/repositories/types";

/**
 * เลือกรอบที่คำสั่งหมายถึง เมื่อกลุ่มเปิดได้หลายรอบพร้อมกัน (PRP multi-open-rounds §4)
 * หลักเดียวกับการเลือกบิล: ดูเฉพาะรอบที่คำสั่งนั้นทำได้จริง เหลือรอบเดียวทำเลย หลายรอบถาม
 */

/** กลุ่มหนึ่งเปิดรอบพร้อมกันได้ไม่เกินนี้ (PRP multi-open-rounds §2) */
export const MAX_OPEN_GAMES = 3;

/** รอบหนึ่งรอบพร้อมรายชื่อคนที่ลงแล้ว ใช้ตัดสินว่าคำสั่งนี้ทำกับรอบไหนได้บ้าง */
export type Round = { game: GameRow; players: GamePlayerRow[] };

/**
 * รอบที่ผู้ใช้ระบุมา ไม่ระบุคือยังไม่รู้
 * date / time มาจาก LLM เท่านั้น คำสั่งพิมพ์ไม่รับวันต่อท้าย (PRP §3.2)
 * gameId มาจากปุ่มบนการ์ด "รอบไหน?"
 */
export type RoundSelector = { date?: string; time?: string; gameId?: string };

/** คำสั่งที่การ์ด "รอบไหน?" จำไว้ กดเลือกรอบแล้วจะทำคำสั่งนี้ต่อ */
export const ROUND_INTENTS = ["join", "join_for", "leave", "leave_for", "edit", "cancel", "close", "bill"] as const;
export type RoundIntent = (typeof ROUND_INTENTS)[number];

export function isRoundIntent(value: unknown): value is RoundIntent {
  return (ROUND_INTENTS as readonly unknown[]).includes(value);
}

export type RoundPick =
  /** labeled = กลุ่มเปิดอยู่หลายรอบ ผลลัพธ์ต้องบอกว่ารอบไหน (§4.4) */
  | { kind: "one"; round: Round; labeled: boolean }
  | { kind: "choose"; rounds: Round[] }
  /** มีรอบอยู่แต่คำสั่งนี้ทำกับรอบไหนไม่ได้เลย ผู้เรียกบอกเหตุผลของคำสั่งตัวเอง */
  | { kind: "none"; rounds: Round[] };

/** รายชื่อของทุกรอบอ่านใน query เดียว ไม่ยิงทีละรอบ */
export async function loadRounds(games: GameRow[]): Promise<Round[]> {
  const players = await listJoinedPlayersOf(games.map((game) => game.id));
  return games.map((game) => ({
    game,
    players: players.filter((player) => player.game_id === game.id),
  }));
}

export async function loadOpenRounds(lineGroupId: string): Promise<Round[]> {
  return loadRounds(await listOpenGames(lineGroupId));
}

export function hasJoined(round: Round, userId: string): boolean {
  return round.players.some((player) => player.user_id === userId);
}

export function isFull(round: Round): boolean {
  return round.players.length >= round.game.max_players;
}

/**
 * รอบที่ตรงกับที่ผู้ใช้ระบุ ไม่ระบุคือทุกรอบ
 * ปุ่มของรอบที่ถูกปิดไปแล้วกดแล้วไม่มีผล (§5) ส่วนวันที่ LLM ส่งมาแต่ไม่มีรอบวันนั้น ต้องบอกให้รู้
 */
export function matchRounds(rounds: Round[], selector: RoundSelector = {}): Round[] {
  const matched = rounds.filter(
    ({ game }) =>
      (!selector.gameId || game.id === selector.gameId) &&
      (!selector.date || game.play_date === selector.date) &&
      (!selector.time || game.start_time === selector.time),
  );
  if (matched.length > 0) return matched;

  if (selector.gameId) throw new AppError("PENDING_EXPIRED");
  if (selector.date || selector.time) {
    throw new AppError("NO_OPEN_GAME", { round_date: selector.date, round_time: selector.time });
  }
  throw new AppError("NO_OPEN_GAME");
}

/**
 * เลือกรอบที่คำสั่งนี้หมายถึง (PRP multi-open-rounds §4.1)
 *
 * เหลือรอบเดียว = รอบนั้นเลย ให้งานจริงบอกเองว่าทำไม่ได้เพราะอะไร กลุ่มที่เปิดรอบเดียวจึงได้ข้อความเหมือนเดิมทุกคำ
 * หลายรอบ = ดูเฉพาะรอบที่คำสั่งนี้ทำได้ (fits) เหลือหนึ่งทำเลย หลายรอบถาม ไม่เหลือเลยให้ผู้เรียกบอกเหตุผล
 */
export function pickRound(
  rounds: Round[],
  fits: (round: Round) => boolean,
  selector: RoundSelector = {},
): RoundPick {
  const pool = matchRounds(rounds, selector);
  const labeled = rounds.length > 1;
  if (pool.length === 1) return { kind: "one", round: pool[0]!, labeled };

  const fitting = pool.filter(fits);
  if (fitting.length === 1) return { kind: "one", round: fitting[0]!, labeled };
  if (fitting.length > 1) return { kind: "choose", rounds: fitting };
  return { kind: "none", rounds: pool };
}

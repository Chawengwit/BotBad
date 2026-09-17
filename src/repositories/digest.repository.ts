import { getSql, type Queryable } from "@/lib/db";
import type { GameRow } from "./types";

/**
 * ข้อมูลที่สรุปประจำสัปดาห์ต้องใช้ (PRP guests-split-bills-and-digest §6.2)
 *
 * อ่านทีเดียวทั้งระบบแล้วค่อยแยกตามกลุ่ม ไม่ยิงทีละกลุ่ม
 * เพราะจำนวนกลุ่มโตได้ แต่ข้อมูลที่สนใจมีแค่รอบที่เปิดอยู่กับบิลที่ยังค้าง
 */

export type GroupDigestData = {
  lineGroupId: string;
  /** รอบที่ยังเปิดอยู่ มีได้ไม่เกินหนึ่งรอบต่อกลุ่ม (spec §7) */
  game: GameRow | null;
  joinedCount: number;
  unpaidBillCount: number;
  unpaidTotalSatang: number;
};

type OpenGameRow = GameRow & { joined_count: number };

async function listOpenGames(sql: Queryable): Promise<OpenGameRow[]> {
  return sql<OpenGameRow[]>`
    SELECT g.id,
           g.line_group_id,
           g.created_by,
           to_char(g.play_date, 'YYYY-MM-DD') AS play_date,
           to_char(g.start_time, 'HH24:MI') AS start_time,
           g.duration_minutes,
           g.court_count,
           g.max_players,
           g.status,
           g.court_name,
           g.location_url,
           g.promptpay,
           g.edit_count,
           (
             SELECT COUNT(*)::int
             FROM game_players gp
             WHERE gp.game_id = g.id AND gp.status = 'joined'
           ) AS joined_count
    FROM games g
    WHERE g.status = 'open'
  `;
}

type UnpaidRow = {
  line_group_id: string;
  bill_count: number;
  unpaid_total_satang: number;
};

/**
 * บิลที่ส่งไปแล้วและยังมีคนไม่จ่าย นับรวมทั้งกลุ่ม ไม่แยกเป็นรายคน
 *
 * อ่านกลุ่มจาก bills.line_group_id ตรง ๆ ไม่ใช่ join ผ่าน games
 * เพราะบิลลอย ๆ ไม่มี game_id ถ้า join จะตกหล่นไปทั้งใบ
 */
async function listUnpaidBills(sql: Queryable): Promise<UnpaidRow[]> {
  return sql<UnpaidRow[]>`
    SELECT b.line_group_id,
           COUNT(DISTINCT b.id)::int AS bill_count,
           COALESCE(SUM(bs.amount_satang), 0)::int AS unpaid_total_satang
    FROM bills b
    JOIN bill_shares bs ON bs.bill_id = b.id AND bs.paid = false
    WHERE b.status = 'sent'
    GROUP BY b.line_group_id
  `;
}

/** ทุกกลุ่มที่มีเรื่องค้างอยู่ กลุ่มที่ไม่มีอะไรเลยจะไม่อยู่ในผลลัพธ์ */
export async function collectDigestData(
  sql: Queryable = getSql(),
): Promise<GroupDigestData[]> {
  // อ่านทีละ query ไม่ใช้ Promise.all
  // pool ตั้ง max: 1 อยู่แล้ว สอง query จึงวิ่งบน connection เดียวกันและถูก serialize อยู่ดี
  // Promise.all ให้แค่ pipelining ที่ไม่ได้ประโยชน์ แลกกับความเปราะ (งานนี้ทำสัปดาห์ละครั้ง)
  const games = await listOpenGames(sql);
  const unpaid = await listUnpaidBills(sql);

  const byGroup = new Map<string, GroupDigestData>();
  const ensure = (lineGroupId: string): GroupDigestData => {
    const found = byGroup.get(lineGroupId);
    if (found) return found;

    const created: GroupDigestData = {
      lineGroupId,
      game: null,
      joinedCount: 0,
      unpaidBillCount: 0,
      unpaidTotalSatang: 0,
    };
    byGroup.set(lineGroupId, created);
    return created;
  };

  for (const row of games) {
    const { joined_count, ...game } = row;
    const entry = ensure(game.line_group_id);
    entry.game = game;
    entry.joinedCount = joined_count;
  }

  for (const row of unpaid) {
    const entry = ensure(row.line_group_id);
    entry.unpaidBillCount = row.bill_count;
    entry.unpaidTotalSatang = row.unpaid_total_satang;
  }

  return [...byGroup.values()];
}

/**
 * จองสิทธิ์ส่งสรุปของวันนั้น คืน true เฉพาะคนที่จองได้
 *
 * cron ยิงซ้ำได้จาก retry หรือ deploy ซ้ำ ถ้าเช็กแล้วค่อยเขียนทีหลังจะมีช่องให้ส่งสองรอบ
 * เขียนกับเช็กจึงต้องเป็นคำสั่งเดียวกัน (PRP §6.3)
 */
export async function claimDigest(
  lineGroupId: string,
  today: string,
  sql: Queryable = getSql(),
): Promise<boolean> {
  const rows = await sql<{ line_group_id: string }[]>`
    INSERT INTO group_digests (line_group_id, last_sent_on)
    VALUES (${lineGroupId}, ${today}::date)
    ON CONFLICT (line_group_id) DO UPDATE
      SET last_sent_on = EXCLUDED.last_sent_on,
          updated_at = now()
      WHERE group_digests.last_sent_on < EXCLUDED.last_sent_on
    RETURNING line_group_id
  `;
  return rows.length > 0;
}

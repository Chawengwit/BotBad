import type { LineMessage } from "@/lib/line";
import { digestCard } from "@/line/messages";
import { todayInBangkok } from "@/lib/time";
import type { GroupDigestData } from "@/repositories/digest.repository";

/**
 * สรุปประจำสัปดาห์ (PRP guests-split-bills-and-digest §6)
 *
 * กติกาที่ทั้งไฟล์นี้ยึด:
 * - ไม่มีเรื่องจะบอก = ไม่ส่ง ไม่ทักทาย เพราะข้อความที่ไม่มีเนื้อหาคือข้อความที่คนเริ่มไม่อ่าน
 * - ห้ามเอ่ยชื่อคนค้างจ่าย บอกได้แค่ว่ามีกี่ใบและค้างเท่าไหร่
 */

export type DigestLines = {
  /** รอบที่เปิดอยู่ พูดถึงเสมอไม่ว่าจะตีวันไหน เพราะสรุปมาสัปดาห์ละครั้ง */
  game: { playDate: string; startTime: string; durationMinutes: number; courtName: string | null; joined: number; max: number } | null;
  /** รอบที่วันเล่นผ่านไปแล้วแต่ยังไม่ปิด กลุ่มจะเปิดรอบใหม่ไม่ได้จนกว่าจะปิด (spec §7) */
  gameIsOverdue: boolean;
  unpaidBillCount: number;
  unpaidTotalSatang: number;
};

/** คืน null เมื่อกลุ่มนี้ไม่มีอะไรต้องบอก */
export function summarizeGroup(
  data: GroupDigestData,
  today: string = todayInBangkok(),
): DigestLines | null {
  const hasBills = data.unpaidBillCount > 0;
  if (!data.game && !hasBills) return null;

  return {
    game: data.game
      ? {
          playDate: data.game.play_date,
          startTime: data.game.start_time,
          durationMinutes: data.game.duration_minutes,
          courtName: data.game.court_name,
          joined: data.joinedCount,
          max: data.game.max_players,
        }
      : null,
    gameIsOverdue: data.game !== null && data.game.play_date < today,
    unpaidBillCount: data.unpaidBillCount,
    unpaidTotalSatang: data.unpaidTotalSatang,
  };
}

/** ข้อความที่จะ push คืน null เมื่อไม่ต้องส่ง */
export function buildDigest(
  data: GroupDigestData,
  today: string = todayInBangkok(),
): LineMessage[] | null {
  const lines = summarizeGroup(data, today);
  return lines ? [digestCard(lines)] : null;
}

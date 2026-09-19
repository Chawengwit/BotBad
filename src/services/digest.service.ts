import type { LineMessage } from "@/lib/line";
import { digestCard } from "@/line/messages";
import type { GroupDigestData } from "@/repositories/digest.repository";

/**
 * สรุปประจำสัปดาห์ (PRP guests-split-bills-and-digest §6)
 *
 * กติกาที่ทั้งไฟล์นี้ยึด:
 * - ไม่มีเรื่องจะบอก = ไม่ส่ง ไม่ทักทาย เพราะข้อความที่ไม่มีเนื้อหาคือข้อความที่คนเริ่มไม่อ่าน
 * - ห้ามเอ่ยชื่อคนค้างจ่าย บอกได้แค่ว่ามีกี่ใบและค้างเท่าไหร่
 *
 * ไม่มีหัวข้อ "รอบค้างเก่า" แล้ว รอบที่เลยวันเล่นถูกปิดอัตโนมัติทุกเช้า (PRP multi-open-rounds §5)
 */

export type DigestLines = {
  /** ทุกรอบที่เปิดอยู่ พูดถึงเสมอไม่ว่าจะตีวันไหน เพราะสรุปมาสัปดาห์ละครั้ง */
  games: {
    playDate: string;
    startTime: string;
    durationMinutes: number;
    courtName: string | null;
    joined: number;
    max: number;
  }[];
  unpaidBillCount: number;
  unpaidTotalSatang: number;
};

/** คืน null เมื่อกลุ่มนี้ไม่มีอะไรต้องบอก */
export function summarizeGroup(data: GroupDigestData): DigestLines | null {
  if (data.games.length === 0 && data.unpaidBillCount === 0) return null;

  return {
    games: data.games.map(({ game, joinedCount }) => ({
      playDate: game.play_date,
      startTime: game.start_time,
      durationMinutes: game.duration_minutes,
      courtName: game.court_name,
      joined: joinedCount,
      max: game.max_players,
    })),
    unpaidBillCount: data.unpaidBillCount,
    unpaidTotalSatang: data.unpaidTotalSatang,
  };
}

/** ข้อความที่จะ push คืน null เมื่อไม่ต้องส่ง */
export function buildDigest(data: GroupDigestData): LineMessage[] | null {
  const lines = summarizeGroup(data);
  return lines ? [digestCard(lines)] : null;
}

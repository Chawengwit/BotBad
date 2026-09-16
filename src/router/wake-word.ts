export const WAKE_WORD = "บอทจ๋า";

/**
 * ข้อความต้องขึ้นต้นด้วย "บอทจ๋า" (อนุญาตช่องว่างนำหน้า)
 * ไม่บังคับเว้นวรรคหลัง wake word เพราะภาษาไทยมักพิมพ์ติดกัน เช่น "บอทจ๋าเปิดตี"
 *
 * การแยกคำสั่งที่ตามหลัง wake word เป็นงานของ Router (spec §18) ซึ่งยังไม่ได้ทำ
 */
export function hasWakeWord(text: string): boolean {
  return text.trimStart().startsWith(WAKE_WORD);
}

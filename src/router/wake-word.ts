export const WAKE_WORD = "บอทจ๋า";

// ช่องว่างปกติ + อักขระล่องหนที่มักติดมาเวลา copy ข้อความมาวาง (zero-width, soft hyphen, BOM)
const INVISIBLE_PREFIX = /^[\s­​-‏⁠﻿]+/u;

/**
 * ข้อความต้องขึ้นต้นด้วย "บอทจ๋า" (อนุญาตช่องว่างและอักขระล่องหนนำหน้า)
 * ไม่บังคับเว้นวรรคหลัง wake word เพราะภาษาไทยมักพิมพ์ติดกัน เช่น "บอทจ๋าเปิดตี"
 *
 * ที่นี่ตอบแค่ว่า "เรียกบอทไหม" การแยกคำสั่งที่ตามหลัง wake word เป็นงานของ parseCommand ใน rule-commands.ts
 */
export function hasWakeWord(text: string): boolean {
  return text.replace(INVISIBLE_PREFIX, "").startsWith(WAKE_WORD);
}

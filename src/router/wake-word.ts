export const WAKE_WORD = "บอทจ๋า";

export type WakeWordResult = { matched: false } | { matched: true; command: string };

/**
 * ข้อความต้องขึ้นต้นด้วย "บอทจ๋า" (อนุญาตช่องว่างนำหน้า)
 * ไม่บังคับเว้นวรรคหลัง wake word เพราะภาษาไทยมักพิมพ์ติดกัน เช่น "บอทจ๋าเปิดตี"
 */
export function matchWakeWord(text: string): WakeWordResult {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(WAKE_WORD)) return { matched: false };
  return { matched: true, command: trimmed.slice(WAKE_WORD.length).trim() };
}

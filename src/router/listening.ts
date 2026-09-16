/**
 * ตัวช่วยของ "โหมดฟัง" (spec §6)
 *
 * โหมดฟังคือช่วง 2 นาทีหลังมีคนเรียก "บอทจ๋า" ที่บอทยอมรับข้อความถัดไปของคนนั้นโดยไม่ต้องมีคำเรียกอีก
 * ไฟล์นี้เก็บเฉพาะการ "ตัดสินใจจากตัวข้อความ" ส่วนการจำว่าใครเปิดโหมดฟังอยู่เป็นงานของ session.repository
 *
 * ทุกอย่างในนี้ทำงานก่อนแตะฐานข้อมูลและก่อนเรียก Gemini เพราะระหว่างโหมดฟัง
 * ทุกข้อความของคนนั้นมีสิทธิ์ยิง LLM การคัดออกตั้งแต่ต้นจึงประหยัดทั้งโควตาและเวลาตอบ
 */

/** พิมพ์คำพวกนี้เพื่อบอกบอทว่าจบเรื่องแล้ว ไม่ต้องฟังต่อ */
const STOP_WORDS = [
  "พอแล้ว",
  "พอ",
  "จบ",
  "จบแล้ว",
  "เลิก",
  "ไม่เอาแล้ว",
  "ขอบคุณ",
  "ขอบใจ",
  "thanks",
  "thank you",
  "bye",
];

/** คำรับคำสั้น ๆ ที่แทบไม่มีทางเป็นคำสั่ง ไม่ต้องเปลืองโควตา LLM ไปถาม */
const SMALL_TALK = [
  "555",
  "55",
  "โอเค",
  "โอเคร",
  "โอเคๆ",
  "ok",
  "okay",
  "okk",
  "ครับ",
  "คับ",
  "ค่ะ",
  "คะ",
  "จ้า",
  "จ้าา",
  "จ๊ะ",
  "ได้",
  "ได้เลย",
  "อือ",
  "อืม",
  "เยี่ยม",
  "ดี",
  "yes",
  "no",
];

/** มีแต่อีโมจิ เครื่องหมายวรรคตอน หรือช่องว่าง ไม่มีตัวอักษรหรือตัวเลขเลย */
const NO_LETTERS = /^[^\p{L}\p{N}]*$/u;

/** ตัดช่องว่าง เครื่องหมายวรรคตอนท้ายประโยค และตัวซ้ำรัว ๆ ("โอเคคคค" → "โอเค") */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[!?.~ๆฯๅ]+$/u, "")
    .replace(/(.)\1{2,}/gu, "$1$1")
    .trim();
}

/** ตรงกับคำในรายการหลัง normalize แล้ว ไม่ใช่แค่มีคำนั้นปนอยู่ */
function matches(text: string, words: string[]): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;

  // "โอเคค" ย่อเป็น "โอเคค" ไม่ใช่ "โอเค" เลยเทียบแบบตัดตัวซ้ำท้ายคำอีกชั้น
  const collapsed = normalized.replace(/(.)\1+$/u, "$1");
  return words.includes(normalized) || words.includes(collapsed);
}

/** ผู้ใช้สั่งปิดโหมดฟังเอง */
export function isStopWord(text: string): boolean {
  return matches(text, STOP_WORDS);
}

/**
 * ข้อความที่ไม่ควรเสียโควตา LLM ไปตีความ
 * คำรับคำสั้น ๆ สติกเกอร์ที่มาเป็นอีโมจิ หรือข้อความที่ไม่มีตัวอักษรเลย
 */
export function isSmallTalk(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return true;
  if (NO_LETTERS.test(normalized)) return true;
  return matches(text, SMALL_TALK);
}

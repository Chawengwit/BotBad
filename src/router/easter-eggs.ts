/**
 * มุกประจำก๊วน: คำถามชมความน่ารักที่มีคำตอบตายตัวอยู่แล้ว
 *
 * อยู่ในชั้น rule-based เพราะมุกแบบนี้ต้องตอบเหมือนกันทุกครั้ง
 * ถ้าปล่อยให้ Gemini ตีความ R1/R2 จะมองว่าเป็นคำถามนอกเรื่องแล้วปฏิเสธ
 * (system-prompt.ts มีกฎรองรับไว้อีกชั้น เผื่อคนพิมพ์สำนวนที่ไม่ตรงกับ pattern ที่นี่)
 *
 * ทำงานก่อนแตะฐานข้อมูลและก่อนเรียก LLM เหมือน listening.ts
 */

/** คนเดียวที่บอทยอมตอบชื่อ สะกดได้หลายแบบแต่หมายถึงคนเดียวกัน */
const NAMES = /ก[ิี][่้๊๋]?ฟ(?:ท[์])?|(?<![a-z])give(?![a-z])|เจ้าหมา/iu;

/** คำตอบเวลาถูกถามว่า "ใคร" ใช้ตัวสะกดเดียวตลอด ไม่ต้องล้อตามที่ผู้ใช้พิมพ์ */
const ANSWER_NAME = "กิ้ฟ";

/** คำชมที่มุกนี้รองรับ คำตอบคือคำเดียวกันต่อท้ายด้วย "ที่สุด" */
const COMPLIMENTS = ["น่ารัก", "สวย"];

/** คำลงท้ายที่บอกว่ากำลังถาม ไม่ใช่บอกเล่า */
const QUESTION = /มั[้๊]?ย|ไหม|ป่าว|ปะ|เปล่า|รึ|หรอ|เหรอ/u;

/**
 * คืนข้อความตอบกลับเมื่อข้อความเข้าข่ายมุกนี้ ไม่เข้าข่ายคืน null ให้ผู้เรียกไปต่อตามปกติ
 * รับข้อความที่ตัด wake word ออกแล้ว
 */
export function easterEggReply(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  const compliment = COMPLIMENTS.find((word) => normalized.includes(word));
  if (!compliment) return null;

  // "ใครน่ารักที่สุด" / "ใครสวยที่สุด" → ตอบเป็นชื่อ ไม่ต้องมีชื่อในคำถาม
  if (normalized.includes("ใคร") && normalized.includes("ที่สุด")) return ANSWER_NAME;

  // "กิ้ฟน่ารักมั้ย" → ตอบว่าที่สุด เฉพาะชื่อในรายการ ถามถึงคนอื่นปล่อยผ่านไปให้ LLM
  if (NAMES.test(normalized) && QUESTION.test(normalized)) return `${compliment}ที่สุด`;

  return null;
}

/**
 * ความยาวขั้นต่ำของค่าที่ถือว่าเป็น secret
 * สั้นกว่านี้การ redact จะไปโดนคำทั่วไปใน log แทน env.ts จึงบังคับความยาวขั้นต่ำเท่ากัน
 */
export const MIN_SECRET_LENGTH = 8;

const MAX_LOG_LENGTH = 500;
const MAX_CAUSE_DEPTH = 5;

// สระบนล่างและวรรณยุกต์ไทย ถ้าตัดข้อความแล้วเหลือค้างไว้จะกลายเป็นตัวลอย อ่านไม่ออก
const TRAILING_THAI_MARKS = /[ัิ-ฺ็-๎]+$/u;
const TRAILING_HIGH_SURROGATE = /[\ud800-\udbff]$/u;

/** ตัดข้อความโดยไม่ทำให้อักขระตัวสุดท้ายพัง */
export function truncate(text: string, maxLength: number = MAX_LOG_LENGTH): string {
  if (text.length <= maxLength) return text;

  let cut = text.slice(0, maxLength);
  cut = cut.replace(TRAILING_HIGH_SURROGATE, "");
  cut = cut.replace(TRAILING_THAI_MARKS, "");
  return `${cut}…`;
}

/** ไล่ error.cause ด้วย เพราะ fetch ของ Node เก็บสาเหตุจริงไว้ตรงนั้น (TypeError: fetch failed) */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const chain: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      chain.push(`${current.name}: ${current.message}`);
      current = current.cause;
    } else {
      chain.push(String(current));
      break;
    }
  }

  return chain.join(" ← caused by ");
}

/**
 * แปลง error เป็นข้อความสำหรับ log โดย:
 * - รวม error.cause เข้ามาด้วย
 * - ตัด secret ที่อาจติดมากับข้อความ (เช่น TypeError ของ fetch ที่มี Authorization header)
 * - จำกัดความยาว กัน log บวมจาก response body ก้อนใหญ่
 */
export function formatErrorForLog(error: unknown, secrets: readonly string[] = []): string {
  const described = describeError(error);

  const redacted = secrets.reduce(
    (text, secret) =>
      secret.length >= MIN_SECRET_LENGTH ? text.split(secret).join("[redacted]") : text,
    described,
  );

  return truncate(redacted);
}

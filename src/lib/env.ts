import { z } from "zod";
import { MIN_SECRET_LENGTH } from "./log";

// ค่า secret ของ LINE เป็น ASCII ที่พิมพ์ได้และไม่มีช่องว่าง
// กันค่าที่ copy มาแล้วมี \n หรือเว้นวรรคติดมา ซึ่งจะทำให้ signature ผิดทุก request
// และถ้าหลุดไปอยู่ใน HTTP header จะทำให้ fetch throw พร้อมค่า token ในข้อความ error
const lineSecretSchema = z
  .string()
  .trim()
  .min(MIN_SECRET_LENGTH)
  .regex(/^[\x21-\x7e]+$/, "must not contain spaces or control characters");

const LINE_ENV_KEYS = ["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"] as const;

export type LineEnvKey = (typeof LINE_ENV_KEYS)[number];
export type LineEnv = Record<LineEnvKey, string>;

function readSecret(name: LineEnvKey): string {
  const parsed = lineSecretSchema.safeParse(process.env[name]);
  if (parsed.success) return parsed.data;

  // ใส่แค่ชื่อตัวแปรกับเหตุผล ห้ามใส่ค่าจริงเพราะข้อความนี้ถูก log ต่อ
  const reasons = parsed.error.issues.map((issue) => issue.message).join(", ");
  throw new Error(`Invalid ${name}: ${reasons}`);
}

/** ใช้ตรวจ signature ต้องอ่านได้โดยไม่ต้องมี access token */
export function getLineChannelSecret(): string {
  return readSecret("LINE_CHANNEL_SECRET");
}

/** ใช้ตอนจะ reply เท่านั้น */
export function getLineAccessToken(): string {
  return readSecret("LINE_CHANNEL_ACCESS_TOKEN");
}

/** ตรวจ env ของ LINE ทั้งหมด รายงานทุกตัวที่ผิดในทีเดียว */
export function getLineEnv(): LineEnv {
  const values = {} as LineEnv;
  const errors: string[] = [];

  for (const key of LINE_ENV_KEYS) {
    try {
      values[key] = readSecret(key);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (errors.length > 0) throw new Error(errors.join("; "));
  return values;
}

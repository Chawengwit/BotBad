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

// connection string มีรหัสผ่านอยู่ข้างใน ห้ามเอาค่าไปใส่ใน error หรือ log
const databaseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^postgres(ql)?:\/\//.test(value), "must start with postgresql://");

// ชื่อ schema ต้องปลอดภัยพอที่จะต่อเข้า SQL ได้ตรง ๆ (ใช้เป็น startup parameter)
const schemaSchema = z
  .string()
  .trim()
  .regex(/^[a-z_][a-z0-9_]*$/, "must be a lowercase identifier")
  .default("public");

/** connection string ของ Supabase ใช้ transaction pooler (port 6543) */
export function getDatabaseUrl(): string {
  const parsed = databaseUrlSchema.safeParse(process.env.DATABASE_URL);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(`Invalid DATABASE_URL: ${reasons}`);
  }
  return parsed.data;
}

/** schema ที่จะใช้ ปกติคือ public ส่วนตอนเทสใช้ schema แยกผ่าน DB_SCHEMA */
export function getDatabaseSchema(): string {
  const parsed = schemaSchema.safeParse(process.env.DB_SCHEMA ?? undefined);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map((issue) => issue.message).join(", ");
    throw new Error(`Invalid DB_SCHEMA: ${reasons}`);
  }
  return parsed.data;
}

const geminiModelSchema = z.string().trim().min(1).default("gemini-2.5-flash");

export type GeminiConfig = { apiKey: string; model: string };

/** null เมื่อยังไม่ได้ตั้ง GEMINI_API_KEY ระบบจะถอยไปใช้เมนูปุ่มแทน (LLM Design §9) */
export function getGeminiConfigOrNull(): GeminiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  const model = geminiModelSchema.safeParse(process.env.GEMINI_MODEL ?? undefined);
  return { apiKey, model: model.success ? model.data : "gemini-2.5-flash" };
}

export function getGeminiConfig(): GeminiConfig {
  const config = getGeminiConfigOrNull();
  if (!config) throw new Error("Missing GEMINI_API_KEY");
  return config;
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

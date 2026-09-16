import { z } from "zod";

// ค่า secret ของ LINE เป็น ASCII ที่พิมพ์ได้และไม่มีช่องว่าง
// กันค่าที่ copy มาแล้วมี \n หรือเว้นวรรคติดมา ซึ่งจะทำให้ signature ผิดทุก request
// และถ้าหลุดไปอยู่ใน HTTP header จะทำให้ fetch throw พร้อมค่า token ในข้อความ error
const lineSecretSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[\x21-\x7e]+$/, "must not contain spaces or control characters");

const lineEnvSchema = z.object({
  LINE_CHANNEL_SECRET: lineSecretSchema,
  LINE_CHANNEL_ACCESS_TOKEN: lineSecretSchema,
});

export type LineEnv = z.infer<typeof lineEnvSchema>;

function describeIssues(error: z.ZodError): string {
  // ใช้แค่ชื่อตัวแปรกับเหตุผล ห้ามใส่ค่าจริงลงใน error เพราะถูก log ต่อ
  return error.issues.map((issue) => `${issue.path.join(".")} (${issue.message})`).join(", ");
}

/** ตรวจ env ทั้งหมด ใช้ตอน start ผ่าน instrumentation.ts */
export function getLineEnv(): LineEnv {
  const parsed = lineEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid LINE environment variables: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** ใช้ตรวจ signature ต้องอ่านได้โดยไม่ต้องมี access token */
export function getLineChannelSecret(): string {
  const parsed = lineSecretSchema.safeParse(process.env.LINE_CHANNEL_SECRET);
  if (!parsed.success) {
    throw new Error(`Invalid LINE_CHANNEL_SECRET: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** ใช้ตอนจะ reply เท่านั้น */
export function getLineAccessToken(): string {
  const parsed = lineSecretSchema.safeParse(process.env.LINE_CHANNEL_ACCESS_TOKEN);
  if (!parsed.success) {
    throw new Error(`Invalid LINE_CHANNEL_ACCESS_TOKEN: ${describeIssues(parsed.error)}`);
  }
  return parsed.data;
}

const MAX_LOG_LENGTH = 500;
const MIN_REDACTABLE_LENGTH = 8;

/**
 * แปลง error เป็นข้อความสำหรับ log โดย:
 * - ตัด secret ที่อาจติดมากับข้อความ (เช่น TypeError ของ fetch ที่มี Authorization header)
 * - จำกัดความยาว กัน log บวมจาก response body ก้อนใหญ่
 */
export function formatErrorForLog(error: unknown, secrets: readonly string[] = []): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  const redacted = secrets.reduce(
    (text, secret) =>
      secret.length >= MIN_REDACTABLE_LENGTH ? text.split(secret).join("[redacted]") : text,
    raw,
  );

  return redacted.length > MAX_LOG_LENGTH ? `${redacted.slice(0, MAX_LOG_LENGTH)}…` : redacted;
}

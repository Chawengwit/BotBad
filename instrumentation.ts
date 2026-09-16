/**
 * ตรวจ environment variables ตอน start ตาม spec §24
 * ไม่ throw เพราะจะทำให้ server ตายทั้งตัว แต่ log ให้เห็นชัดตั้งแต่ deploy แรก
 */
export async function register(): Promise<void> {
  const { getLineEnv } = await import("@/lib/env");
  const { formatErrorForLog } = await import("@/lib/log");

  try {
    getLineEnv();
    console.log("[startup] LINE environment variables OK");
  } catch (error) {
    console.error("[startup]", formatErrorForLog(error));
  }
}

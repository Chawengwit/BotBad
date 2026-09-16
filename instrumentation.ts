/**
 * ตรวจ environment variables ตอน start ตาม spec §24
 * ห้าม throw เพราะจะทำให้ server ตายทั้งตัว (webhook ตอบ 503 พร้อมเหตุผลอยู่แล้วถ้า env ไม่ครบ)
 * import ต้องอยู่ใน try ด้วย ไม่งั้น module ที่โหลดไม่ขึ้นจะทำให้ hook นี้ throw เสียเอง
 */
export async function register(): Promise<void> {
  try {
    const [{ getLineEnv }, { formatErrorForLog }] = await Promise.all([
      import("@/lib/env"),
      import("@/lib/log"),
    ]);

    try {
      getLineEnv();
      console.log("[startup] LINE environment variables OK");
    } catch (error) {
      console.error("[startup] LINE environment variables are not usable:", formatErrorForLog(error));
    }
  } catch (error) {
    // ถึงตรงนี้แปลว่าโหลด module ไม่ได้ จึงยังใช้ formatErrorForLog ไม่ได้
    console.error(
      "[startup] could not run the environment check:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

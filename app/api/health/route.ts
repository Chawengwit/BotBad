import { getSql } from "@/lib/db";
import { formatErrorForLog } from "@/lib/log";

// ใช้ node:crypto ทางอ้อมผ่าน postgres.js จึงต้องเป็น Node runtime
export const runtime = "nodejs";

/**
 * ตรวจว่าแอปกับฐานข้อมูลยังคุยกันได้
 * Vercel Cron เรียกวันละครั้ง เพื่อไม่ให้โปรเจค Supabase แบบ Free ถูก pause จากการไม่มีการใช้งาน
 */
export async function GET(request: Request): Promise<Response> {
  // ตั้ง CRON_SECRET ไว้เมื่อไหร่ ก็ต้องส่ง Authorization มาด้วยเมื่อนั้น
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const rows = await getSql()<{ ok: number }[]>`SELECT 1 AS ok`;
    return Response.json({ ok: rows[0]?.ok === 1 });
  } catch (error) {
    console.error("[health] database check failed:", formatErrorForLog(error));
    return Response.json({ ok: false }, { status: 503 });
  }
}

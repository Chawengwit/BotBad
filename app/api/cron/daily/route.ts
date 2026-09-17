import { getLineAccessToken } from "@/lib/env";
import { getSql } from "@/lib/db";
import { getMessageQuota, pushMessages } from "@/lib/line";
import { formatErrorForLog } from "@/lib/log";
import { isFridayInBangkok, todayInBangkok } from "@/lib/time";
import { claimDigest, collectDigestData } from "@/repositories/digest.repository";
import { buildDigest } from "@/services/digest.service";

// ใช้ node:crypto ทางอ้อมผ่าน postgres.js จึงต้องเป็น Node runtime
export const runtime = "nodejs";

/**
 * งานประจำวันของบอท (PRP guests-split-bills-and-digest §6.1)
 *
 * cron ยิง "ทุกวัน" ตอน 10 โมงไทย แต่ push เฉพาะวันศุกร์
 *   ทุกวัน  → แตะฐานข้อมูล กันโปรเจค Supabase แบบ Free ถูก pause จากการไม่มีการใช้งาน
 *   ศุกร์    → แตะฐานข้อมูล + ส่งสรุปเข้ากลุ่มที่มีเรื่องจะบอก
 *
 * ที่ไม่ตั้ง cron เป็นรายสัปดาห์ไปเลย เพราะ Supabase pause เมื่อไม่มีการใช้งานครบ 7 วัน
 * ซึ่งเท่ากับระยะห่างของ cron รายศุกร์พอดี บวกความคลาด ±59 นาทีของ Hobby แล้วอาจหลุด
 */

/** หยุด push เมื่อใช้โควตาของเดือนไปแล้วเกินสัดส่วนนี้ (PRP §6.4) */
const DEFAULT_QUOTA_STOP_AT = 0.8;

function quotaStopAt(): number {
  const raw = Number(process.env.PUSH_QUOTA_STOP_AT);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_QUOTA_STOP_AT;
}

/** true = ยังส่งได้ โควตาอ่านไม่ได้ก็ให้ส่งต่อ ไม่ใช่เงียบทั้งระบบเพราะเช็กไม่ได้ */
async function hasQuotaRoom(accessToken: string): Promise<boolean> {
  try {
    const { limit, used } = await getMessageQuota(accessToken);
    if (limit === null) return true;

    const stopAt = quotaStopAt();
    if (used < limit * stopAt) return true;

    console.error(
      `[cron] หยุดส่งสรุป: ใช้โควตาไปแล้ว ${used}/${limit} ซึ่งเกิน ${Math.round(stopAt * 100)}%`,
    );
    return false;
  } catch (error) {
    console.error("[cron] อ่านโควตาไม่ได้ ส่งต่อไปก่อน:", formatErrorForLog(error, [accessToken]));
    return true;
  }
}

type DigestResult = { groups: number; sent: number; skipped: number; failed: number };

async function sendDigests(today: string): Promise<DigestResult> {
  const accessToken = getLineAccessToken();
  const groups = await collectDigestData();
  const result: DigestResult = { groups: groups.length, sent: 0, skipped: 0, failed: 0 };

  if (groups.length === 0) return result;
  if (!(await hasQuotaRoom(accessToken))) {
    result.skipped = groups.length;
    return result;
  }

  for (const group of groups) {
    const messages = buildDigest(group, today);
    if (!messages) {
      result.skipped += 1;
      continue;
    }

    try {
      // จองก่อนส่ง ถ้าจองไม่ได้แปลว่ามีคนส่งไปแล้ววันนี้
      if (!(await claimDigest(group.lineGroupId, today))) {
        result.skipped += 1;
        continue;
      }

      await pushMessages(group.lineGroupId, messages, accessToken);
      result.sent += 1;
    } catch (error) {
      // กลุ่มหนึ่งพังต้องไม่ทำให้กลุ่มที่เหลือไม่ได้รับ (PRP §6.5)
      result.failed += 1;
      console.error("[cron] ส่งสรุปไม่สำเร็จ:", formatErrorForLog(error, [accessToken]));
    }
  }

  return result;
}

export async function GET(request: Request): Promise<Response> {
  // ตั้ง CRON_SECRET ไว้เมื่อไหร่ ก็ต้องส่ง Authorization มาด้วยเมื่อนั้น
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await getSql()`SELECT 1 AS ok`;
  } catch (error) {
    console.error("[cron] ต่อฐานข้อมูลไม่ได้:", formatErrorForLog(error));
    return Response.json({ ok: false }, { status: 503 });
  }

  const today = todayInBangkok();
  if (!isFridayInBangkok()) {
    return Response.json({ ok: true, today, digest: "ยังไม่ถึงวันศุกร์" });
  }

  try {
    return Response.json({ ok: true, today, digest: await sendDigests(today) });
  } catch (error) {
    // ฐานข้อมูลตอบแล้ว ถือว่างานหลักผ่าน สรุปพังก็แค่ log ไม่ต้องให้ cron ขึ้นแดง
    console.error("[cron] สรุปประจำสัปดาห์ล้มทั้งชุด:", formatErrorForLog(error));
    return Response.json({ ok: true, today, digest: "failed" });
  }
}

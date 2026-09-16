import { getGroupMemberDisplayName } from "@/lib/line";
import { upsertUser } from "@/repositories/user.repository";
import type { UserRow } from "@/repositories/types";

/** ใช้เมื่อ LINE ไม่ยอมบอกชื่อ เช่น สมาชิกปิดการเข้าถึงโปรไฟล์ */
export const FALLBACK_DISPLAY_NAME = "สมาชิก";

/**
 * บันทึกผู้ใช้จาก LINE event
 * ดึงชื่อจาก LINE ทุกครั้งเพราะสมาชิกเปลี่ยนชื่อได้ตลอด
 */
export async function ensureUser(
  lineGroupId: string,
  lineUserId: string,
  accessToken: string,
): Promise<UserRow> {
  const displayName = await getGroupMemberDisplayName(lineGroupId, lineUserId, accessToken);
  return upsertUser(lineUserId, displayName ?? FALLBACK_DISPLAY_NAME);
}

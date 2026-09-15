import type { TextMessage } from "@/lib/line";
import { matchWakeWord } from "@/router/wake-word";
import type { LineEvent } from "./webhook-schema";

export type ReplyFn = (replyToken: string, messages: TextMessage[]) => Promise<void>;

export const MESSAGES = {
  groupOnly: "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น",
  joinGroup: "🏸 สวัสดีครับ บอทจ๋ามาแล้ว!\n\nพิมพ์ \"บอทจ๋า\" นำหน้าข้อความเพื่อเรียกใช้งานได้เลย",
  // ข้อความชั่วคราวจนกว่าจะมี Router / คำสั่งจริง
  ready: "🏸 บอทจ๋าพร้อมแล้ว!\n\nตอนนี้ระบบกำลังพัฒนาอยู่ เร็ว ๆ นี้จะเปิดรอบและลงชื่อได้นะ",
} as const;

/**
 * คืนข้อความที่ต้องตอบ หรือ null ถ้าต้อง ignore
 * แยกจากการส่งจริงเพื่อให้ test ได้โดยไม่เรียก LINE API
 */
export function resolveReply(event: LineEvent): TextMessage[] | null {
  if (event.type === "join" && event.source?.type === "group") {
    return [{ type: "text", text: MESSAGES.joinGroup }];
  }

  if (event.type !== "message" || event.message?.type !== "text") return null;

  const text = event.message.text ?? "";
  const wake = matchWakeWord(text);
  if (!wake.matched) return null;

  if (event.source?.type !== "group") {
    return [{ type: "text", text: MESSAGES.groupOnly }];
  }

  return [{ type: "text", text: MESSAGES.ready }];
}

export async function handleEvent(event: LineEvent, reply: ReplyFn): Promise<void> {
  const messages = resolveReply(event);
  if (!messages || !event.replyToken) return;
  await reply(event.replyToken, messages);
}

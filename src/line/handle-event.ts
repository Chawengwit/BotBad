import type { TextMessage } from "@/lib/line";
import { hasWakeWord } from "@/router/wake-word";
import type { LineEvent } from "./webhook-schema";

export type ReplyFn = (replyToken: string, messages: TextMessage[]) => Promise<void>;

export const MESSAGES = {
  groupOnly: "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น",
  joinGroup: '🏸 สวัสดีครับ บอทจ๋ามาแล้ว!\n\nพิมพ์ "บอทจ๋า" นำหน้าข้อความเพื่อเรียกใช้งานได้เลย',
} as const;

/**
 * คืนข้อความที่ต้องตอบ หรือ null ถ้าต้อง ignore
 * แยกจากการส่งจริงเพื่อให้ทดสอบ logic ได้โดยไม่เรียก LINE API
 */
function resolveReply(event: LineEvent): TextMessage[] | null {
  if (event.type === "join" && event.source?.type === "group") {
    return [{ type: "text", text: MESSAGES.joinGroup }];
  }

  if (event.type !== "message" || event.message?.type !== "text") return null;
  if (!hasWakeWord(event.message.text ?? "")) return null;

  if (event.source?.type !== "group") {
    return [{ type: "text", text: MESSAGES.groupOnly }];
  }

  // ในกลุ่ม: ยังไม่มี Router (spec §18) จึงยังไม่ตอบ
  return null;
}

export async function handleEvent(event: LineEvent, reply: ReplyFn): Promise<void> {
  const messages = resolveReply(event);
  if (!messages || !event.replyToken) return;
  await reply(event.replyToken, messages);
}

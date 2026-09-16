import type { TextMessage } from "@/lib/line";
import { hasWakeWord, WAKE_WORD } from "@/router/wake-word";
import type { LineEvent } from "./webhook-schema";

export type ReplyFn = (replyToken: string, messages: TextMessage[]) => Promise<void>;

const MESSAGES = {
  groupOnly: "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น",
  // ยังไม่มี Router (spec §18) จึงต้องไม่สัญญาว่าสั่งงานได้แล้ว
  joinGroup: `🏸 สวัสดีครับ บอทจ๋ามาแล้ว!\n\nตอนนี้ยังสั่งงานไม่ได้นะ กำลังติดตั้งระบบอยู่\nพร้อมเมื่อไหร่จะบอกในกลุ่มนี้ แล้วค่อยเรียกด้วยคำว่า "${WAKE_WORD}" ได้เลย`,
} as const;

/**
 * คืนข้อความที่ต้องตอบ หรือ null ถ้าต้อง ignore
 * แยกจากการส่งจริงเพื่อให้ทดสอบ logic ได้โดยไม่เรียก LINE API
 */
function resolveReply(event: LineEvent): TextMessage[] | null {
  const source = event.source;
  // ไม่รู้ว่ามาจากไหนก็ตอบไม่ได้ ทั้ง join และ message ใช้เกณฑ์เดียวกัน
  if (!source) return null;

  if (event.type === "join" && source.type === "group") {
    return [{ type: "text", text: MESSAGES.joinGroup }];
  }

  if (event.type !== "message" || event.message?.type !== "text") return null;
  if (!hasWakeWord(event.message.text ?? "")) return null;

  // ทุก source ที่ไม่ใช่ group (user, room และ type ใหม่ ๆ ของ LINE) ได้คำตอบเดียวกัน
  if (source.type !== "group") {
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

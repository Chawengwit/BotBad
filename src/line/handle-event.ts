import { isAppError } from "@/errors/app-errors";
import type { LineMessage } from "@/lib/line";
import { formatErrorForLog } from "@/lib/log";
import { handlePostback, parsePostbackData } from "@/router/postback";
import { handleRuleCommand, isRuleCommand, stripWakeWord } from "@/router/rule-commands";
import { handleTextAnswer } from "@/router/text-answer";
import { hasWakeWord, WAKE_WORD } from "@/router/wake-word";
import { ensureUser } from "@/services/user.service";
import { errorMessage, text } from "./messages";
import type { LineEvent } from "./webhook-schema";

export type ReplyFn = (replyToken: string, messages: LineMessage[]) => Promise<void>;

export type EventContext = {
  reply: ReplyFn;
  accessToken: string;
};

const MESSAGES = {
  groupOnly: "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น",
  joinGroup: `🏸 สวัสดีครับ บอทจ๋ามาแล้ว!\n\nพิมพ์ "${WAKE_WORD} เปิดตี" เพื่อเปิดรอบตีได้เลย\nคำสั่งอื่น ๆ กำลังทยอยเปิดใช้งาน`,
} as const;

/**
 * ข้อความที่ไม่ได้เรียกบอทโดยตรง ถ้าพังต้องเงียบ
 * ไม่งั้นบอทจะพ่น "ระบบขัดข้อง" ใส่ทุกบทสนทนาในกลุ่มตอนฐานข้อมูลมีปัญหา
 */
async function runQuietly(
  work: () => Promise<LineMessage[] | null>,
  accessToken: string,
): Promise<LineMessage[] | null> {
  try {
    return await work();
  } catch (error) {
    console.error("[handle-event] ignored message failed:", formatErrorForLog(error, [accessToken]));
    return null;
  }
}

/** งานที่ต้องคุยกับฐานข้อมูล ถ้าพังต้องตอบผู้ใช้ให้รู้เรื่อง ไม่ใช่เงียบ */
async function runOrExplain(
  work: () => Promise<LineMessage[] | null>,
  accessToken: string,
): Promise<LineMessage[] | null> {
  try {
    return await work();
  } catch (error) {
    if (isAppError(error)) return [errorMessage(error.code, error.details)];

    console.error("[handle-event] failed:", formatErrorForLog(error, [accessToken]));
    return [errorMessage("INTERNAL_ERROR")];
  }
}

async function resolveMessages(
  event: LineEvent,
  context: EventContext,
): Promise<LineMessage[] | null> {
  const source = event.source;
  // ไม่รู้ว่ามาจากไหนก็ตอบไม่ได้ ทุก event ใช้เกณฑ์เดียวกัน
  if (!source) return null;

  if (event.type === "join" && source.type === "group") {
    return [text(MESSAGES.joinGroup)];
  }

  if (event.type === "postback" && event.postback) {
    const { groupId, userId } = source;
    if (source.type !== "group" || !groupId || !userId) return null;

    // ตรวจข้อมูลของปุ่มก่อน จะได้ไม่เสียแรงเรียก LINE API หรือฐานข้อมูลกับปุ่มปลอม
    const parsed = parsePostbackData(event.postback.data);
    if (!parsed) return null;
    const params = event.postback.params ?? {};

    return runOrExplain(async () => {
      const user = await ensureUser(groupId, userId, context.accessToken);
      return handlePostback(parsed, { params, lineGroupId: groupId, user });
    }, context.accessToken);
  }

  if (event.type !== "message") return null;
  const message = event.message;
  if (!message) return null;

  const isText = message.type === "text";
  const messageText = message.text ?? "";

  // ทุก source ที่ไม่ใช่ group (user, room และ type ใหม่ ๆ ของ LINE) ได้คำตอบเดียวกัน
  if (source.type !== "group") {
    return isText && hasWakeWord(messageText) ? [text(MESSAGES.groupOnly)] : null;
  }

  const { groupId, userId } = source;
  if (!groupId || !userId) return null;

  if (isText && hasWakeWord(messageText)) {
    const command = stripWakeWord(messageText);
    // คำสั่งที่ยังไม่รองรับจะเงียบไว้ก่อน จนกว่าจะต่อ LLM (spec §19)
    if (!isRuleCommand(command)) return null;

    return runOrExplain(async () => {
      const user = await ensureUser(groupId, userId, context.accessToken);
      return handleRuleCommand({ command, lineGroupId: groupId, user });
    }, context.accessToken);
  }

  // ข้อความธรรมดาจะถูกอ่านก็ต่อเมื่อบอทกำลังรอคำตอบจากคนคนนี้อยู่ (ชื่อคอร์ท / แผนที่)
  const isLocation =
    message.type === "location" &&
    typeof message.latitude === "number" &&
    typeof message.longitude === "number";

  if (!isText && !isLocation) return null;

  return runQuietly(
    () =>
      handleTextAnswer({
        lineGroupId: groupId,
        lineUserId: userId,
        ...(isText ? { text: messageText } : {}),
        ...(isLocation
          ? { location: { latitude: message.latitude!, longitude: message.longitude! } }
          : {}),
      }),
    context.accessToken,
  );
}

export async function handleEvent(event: LineEvent, context: EventContext): Promise<void> {
  const messages = await resolveMessages(event, context);
  if (!messages || messages.length === 0 || !event.replyToken) return;
  await context.reply(event.replyToken, messages);
}

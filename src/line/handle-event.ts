import { isAppError } from "@/errors/app-errors";
import { getGeminiConfigOrNull } from "@/lib/env";
import { createGeminiClient } from "@/lib/gemini";
import { runAgent } from "@/llm/agent";
import {
  clearSession,
  closeListeningWindow,
  isListening,
  openListeningWindow,
  setListeningWindow,
} from "@/repositories/session.repository";
import type { LineMessage } from "@/lib/line";
import { formatErrorForLog } from "@/lib/log";
import { isSmallTalk, isStopWord } from "@/router/listening";
import { handlePostback, parsePostbackData, type PostbackData } from "@/router/postback";
import {
  handleRuleCommand,
  isRuleCommand,
  opensWizard,
  stripWakeWord,
} from "@/router/rule-commands";
import { handleTextAnswer } from "@/router/text-answer";
import { hasWakeWord, WAKE_WORD } from "@/router/wake-word";
import { ensureUser } from "@/services/user.service";
import { errorMessage, fallbackMenu, goodbye, greeting, text } from "./messages";
import type { LineEvent } from "./webhook-schema";

export type ReplyFn = (replyToken: string, messages: LineMessage[]) => Promise<void>;

export type EventContext = {
  reply: ReplyFn;
  accessToken: string;
};

const MESSAGES = {
  groupOnly: "ℹ️ บอทนี้ใช้งานได้ใน LINE Group เท่านั้น",
  joinGroup: `🏸 สวัสดีครับ บอทจ๋ามาแล้ว!\n\nพิมพ์ "${WAKE_WORD} เปิดตี" เพื่อเปิดรอบตีได้เลย\nหรือเรียก "${WAKE_WORD}" เฉย ๆ แล้วค่อยบอกทีหลังก็ได้`,
} as const;

/**
 * ปุ่มที่กดแล้วเรื่องจบ ต้องปิดโหมดฟังทันที (spec §6)
 * ปุ่มอ่านข้อมูลอย่าง list / bill_status ไม่นับ เพราะยังอยู่ระหว่างคุยกันอยู่
 */
const CLOSING_POSTBACKS: readonly PostbackData["action"][] = [
  "confirm",
  "reject",
  "join",
  "leave",
  "bill_paid",
  "bill_unpaid",
];

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
      const messages = await handlePostback(parsed, { params, lineGroupId: groupId, user });

      if (CLOSING_POSTBACKS.includes(parsed.action)) {
        await closeListeningWindow(groupId, userId).catch(() => {});
      }
      return messages;
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

  // ไม่มี Gemini ก็ตีความประโยคอิสระไม่ได้ เปิดโหมดฟังไปก็ได้แต่ความเงียบ (spec §19)
  const gemini = getGeminiConfigOrNull();

  if (isText && hasWakeWord(messageText)) {
    const command = stripWakeWord(messageText);

    // "บอทจ๋า พอแล้ว" คือสั่งปิดโหมดฟังเอง ไม่ต้องรอหมดเวลา
    if (isStopWord(command)) {
      await closeListeningWindow(groupId, userId).catch(() => {});
      return [goodbye()];
    }

    if (isRuleCommand(command)) {
      return runOrExplain(async () => {
        const user = await ensureUser(groupId, userId, context.accessToken);
        // ใช้คำสั่งตรงตัวแล้ว ถือว่าจบเรื่องเดิม ล้างบริบทที่คุยค้างไว้
        await clearSession(groupId, userId).catch(() => {});
        const messages = await handleRuleCommand({ command, lineGroupId: groupId, user });

        // คำสั่งที่ตอบมาเป็นคำถามหรือการ์ดยืนยัน = ยังคุยกันไม่จบ ฟังต่อได้เลย
        const keepListening = gemini !== null && opensWizard(command);
        await setListeningWindow(groupId, userId, keepListening).catch(() => {});
        return messages;
      }, context.accessToken);
    }

    // เรียกชื่อเฉย ๆ ยังไม่ได้สั่งอะไร เปิดโหมดฟังรอไว้แล้วทักกลับ
    // เปิดหน้าต่างไม่สำเร็จก็ยังต้องทักกลับ เพราะเรียกชื่อบอทแล้วเงียบคือสิ่งที่ผู้ใช้งงที่สุด
    if (!command) {
      if (!gemini) return [fallbackMenu()];
      await openListeningWindow(groupId, userId).catch(() => {});
      return [greeting()];
    }

    // ภาษาธรรมชาติ: ส่งให้ Gemini ถ้ายังไม่ได้ตั้งค่าไว้ก็ตอบเป็นเมนูปุ่ม (spec §19)
    return runOrExplain(async () => {
      const user = await ensureUser(groupId, userId, context.accessToken);
      if (!gemini) return [fallbackMenu()];

      const reply = await runAgent({
        text: command,
        lineGroupId: groupId,
        lineUserId: userId,
        user,
        client: createGeminiClient(),
      });

      await setListeningWindow(groupId, userId, !reply.done).catch(() => {});
      return reply.messages;
    }, context.accessToken);
  }

  // ข้อความที่ไม่มี wake word จะถูกอ่านใน 2 กรณีเท่านั้น (spec §6)
  //   1. บอทกำลังรอคำตอบจากคนคนนี้อยู่ (ชื่อคอร์ท / แผนที่ / จำนวนเงิน)
  //   2. คนคนนี้เพิ่งเรียกบอทไว้ และยังอยู่ในโหมดฟัง
  const isLocation =
    message.type === "location" &&
    typeof message.latitude === "number" &&
    typeof message.longitude === "number";

  if (!isText && !isLocation) return null;

  return runQuietly(async () => {
    const answered = await handleTextAnswer({
      lineGroupId: groupId,
      lineUserId: userId,
      ...(isText ? { text: messageText } : {}),
      ...(isLocation
        ? { location: { latitude: message.latitude!, longitude: message.longitude! } }
        : {}),
    });
    if (answered) return answered;

    // โหมดฟังรับเฉพาะข้อความ ตำแหน่งที่แชร์มาลอย ๆ ไม่ใช่คำสั่ง
    if (!isText || !gemini) return null;
    if (!(await isListening(groupId, userId))) return null;

    // บอกว่าจบแล้ว หรือเป็นคำรับคำสั้น ๆ ปิดโหมดฟังโดยไม่ต้องเสียโควตา LLM ไปถาม
    if (isStopWord(messageText) || isSmallTalk(messageText)) {
      await closeListeningWindow(groupId, userId);
      return null;
    }

    const user = await ensureUser(groupId, userId, context.accessToken);
    const reply = await runAgent({
      text: messageText,
      lineGroupId: groupId,
      lineUserId: userId,
      user,
      client: createGeminiClient(),
      listening: true,
    });

    await setListeningWindow(groupId, userId, !reply.done);
    return reply.messages.length > 0 ? reply.messages : null;
  }, context.accessToken);
}

export async function handleEvent(event: LineEvent, context: EventContext): Promise<void> {
  const messages = await resolveMessages(event, context);
  if (!messages || messages.length === 0 || !event.replyToken) return;
  await context.reply(event.replyToken, messages);
}

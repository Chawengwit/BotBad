import { isAppError } from "@/errors/app-errors";
import { getGeminiConfigOrNull } from "@/lib/env";
import { createGeminiClient } from "@/lib/gemini";
import { runAgent } from "@/llm/agent";
import {
  clearSession,
  closeListeningWindow,
  isListening,
  openListeningWindow,
  saveSessionMessages,
  setListeningWindow,
} from "@/repositories/session.repository";
import type { LineMessage } from "@/lib/line";
import type { PendingActionRow } from "@/repositories/pending-action.repository";
import type { LineUserRow } from "@/repositories/types";
import { formatErrorForLog } from "@/lib/log";
import { easterEggReply } from "@/router/easter-eggs";
import { isSmallTalk, isStopWord } from "@/router/listening";
import { handlePostback, parsePostbackData } from "@/router/postback";
import {
  handleRuleCommand,
  parseCommand,
  stripWakeWord,
  type ParsedCommand,
} from "@/router/rule-commands";
import { handleTextAnswer } from "@/router/text-answer";
import { hasWakeWord, WAKE_WORD } from "@/router/wake-word";
import { ensureUser } from "@/services/user.service";
import { errorMessage, fallbackMenu, goodbye, greeting, isRoundQuestion, text } from "./messages";
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

/**
 * ทำคำสั่งตรงตัว แล้วต่ออายุโหมดฟังเสมอ (spec §6)
 *
 * ต่ออายุแม้คำสั่งจะล้มเหลว เพราะคนที่เพิ่งโดนบอทบอกว่า "ยังไม่มีรอบที่เปิดอยู่"
 * มักจะสั่งต่อทันที ถ้าปิดหน้าต่างตอนนั้นเขาต้องเรียกชื่อบอทใหม่ทั้งที่เพิ่งคุยกันอยู่
 */
async function runRuleCommand(
  parsed: ParsedCommand,
  groupId: string,
  userId: string,
  user: LineUserRow,
  keepListening: boolean,
): Promise<LineMessage[]> {
  // ใช้คำสั่งตรงตัวแล้ว ถือว่าจบเรื่องเดิม ล้างบริบทที่คุยค้างไว้
  await clearSession(groupId, userId).catch(() => {});
  const command = [parsed.command, parsed.args].join(" ").trim();

  try {
    const messages = await handleRuleCommand({
      command: parsed.command,
      args: parsed.args,
      lineGroupId: groupId,
      user,
    });

    // บอทถามว่ารอบไหน จำคำถามไว้ในบทสนทนา คนพิมพ์ตอบว่า "เสาร์" แทนการกดปุ่มได้ (PRP multi-open-rounds §4.3)
    const question = messages.find(isRoundQuestion);
    if (question) {
      await saveSessionMessages(groupId, userId, [
        { role: "user", text: command },
        { role: "model", text: question.altText },
      ]).catch(() => {});
    }
    return messages;
  } catch (error) {
    if (!isAppError(error)) throw error;
    // ต้องถามว่าบิลไหน ตัวอย่างเป็นคำสั่งเดิมของคนพิมพ์ต่อด้วยชื่อบิล ไม่ใช่คำสั่งดูบิลเสมอ
    return [errorMessage(error.code, { command, ...error.details })];
  } finally {
    await setListeningWindow(groupId, userId, keepListening).catch(() => {});
  }
}

/**
 * ชื่อบิลกับรายการที่พิมพ์ตอบปุ่ม "สร้างบิลใหม่" ให้ Gemini แปลงเป็นบิล
 * ผู้ใช้กำลังตอบคำถามของบอทอยู่ ไม่ใช่โหมดฟัง ตีความไม่ออกจึงต้องได้คำตอบกลับไป ไม่ใช่เงียบ
 */
async function interpretNewBill(
  pending: PendingActionRow,
  text: string,
  groupId: string,
  userId: string,
  context: EventContext,
): Promise<LineMessage[]> {
  const user = await ensureUser(groupId, userId, context.accessToken);
  const reply = await runAgent({
    text,
    lineGroupId: groupId,
    lineUserId: userId,
    user,
    client: createGeminiClient(),
    newBill: { pendingId: pending.id, title: String(pending.payload.title ?? "") },
  });

  await openListeningWindow(groupId, userId).catch(() => {});
  return reply.messages;
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

      let messages: LineMessage[];
      try {
        messages = await handlePostback(parsed, { params, lineGroupId: groupId, user });
      } catch (error) {
        // ปุ่มในกลุ่มทุกคนกดได้ ถ้าตอบทุกครั้งที่มีคนกดปุ่มของคนอื่นหรือปุ่มที่ใช้ไปแล้ว แชทจะรกเปล่า ๆ
        if (isAppError(error) && (error.code === "NOT_REQUESTER" || error.code === "PENDING_EXPIRED")) {
          return null;
        }
        throw error;
      }

      // กดปุ่มคือกำลังคุยกับบอทอยู่ ต่ออายุโหมดฟังให้ ไม่ใช่ปล่อยหมดอายุกลางทาง
      await openListeningWindow(groupId, userId).catch(() => {});
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

    // มุกประจำก๊วน ตอบทันทีโดยไม่แตะฐานข้อมูลและไม่เปลืองโควตา LLM
    const joke = easterEggReply(command);
    if (joke) return [text(joke)];

    // "ลงชื่อ รอบวันเสาร์" พูดถึงรอบ ไม่ใช่รายชื่อคน มี Gemini ให้ Gemini อ่านวันของรอบเอง (PRP multi-open-rounds §15)
    const parsed = parseCommand(command);
    if (parsed && !(parsed.aboutRound && gemini)) {
      return runOrExplain(async () => {
        const user = await ensureUser(groupId, userId, context.accessToken);
        return runRuleCommand(parsed, groupId, userId, user, gemini !== null);
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

      await setListeningWindow(groupId, userId, true).catch(() => {});
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
      ...(gemini
        ? {
            interpretBill: (pending: PendingActionRow, text: string) =>
              interpretNewBill(pending, text, groupId, userId, context),
          }
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

    const joke = easterEggReply(messageText);
    if (joke) return [text(joke)];

    const user = await ensureUser(groupId, userId, context.accessToken);

    // อยู่ในโหมดฟังแล้วพิมพ์คำสั่งตรงตัว ต้องเข้า rule-based เหมือนมี wake word
    // ไม่งั้น "ลงชื่อ" เฉย ๆ จะถูกส่งไปให้ Gemini ตีความทั้งที่รู้อยู่แล้วว่าแปลว่าอะไร
    //
    // คำสั่งตรงตัวถือว่าคุยกับบอทแน่นอน ผิดพลาดก็ต้องบอก ไม่ใช่เงียบแบบข้อความทั่วไป
    const listeningCommand = parseCommand(messageText);
    if (listeningCommand && !listeningCommand.aboutRound) {
      return runRuleCommand(listeningCommand, groupId, userId, user, true);
    }

    const reply = await runAgent({
      text: messageText,
      lineGroupId: groupId,
      lineUserId: userId,
      user,
      client: createGeminiClient(),
      listening: true,
    });

    // ตอบ IGNORE แปลว่า "ข้อความนี้ไม่ได้คุยกับบอท" ไม่ใช่ "จบบทสนทนาแล้ว"
    // ปิดหน้าต่างตรงนี้ทำให้ประโยคกำกวมประโยคเดียวฆ่าบทสนทนาทิ้ง
    // แล้วคำสั่งตรงตัวที่พิมพ์ตามมาก็ตกไปด้วย ปล่อยให้ 2 นาทีหมดอายุเองดีกว่า
    await openListeningWindow(groupId, userId).catch(() => {});
    return reply.messages.length > 0 ? reply.messages : null;
  }, context.accessToken);
}

export async function handleEvent(event: LineEvent, context: EventContext): Promise<void> {
  const messages = await resolveMessages(event, context);
  if (!messages || messages.length === 0 || !event.replyToken) return;
  await context.reply(event.replyToken, messages);
}

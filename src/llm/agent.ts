import type { Content } from "@google/genai";
import type { GeminiClient } from "@/lib/gemini";
import { MAX_TOOL_LOOPS } from "@/lib/gemini";
import { MAX_REPLY_MESSAGES, type LineMessage } from "@/lib/line";
import { formatErrorForLog } from "@/lib/log";
import { fallbackMenu, text } from "@/line/messages";
import { countJoinedPlayers, findOpenGame } from "@/repositories/game.repository";
import { findPlayerStatus } from "@/repositories/player.repository";
import {
  loadSessionMessages,
  saveSessionMessages,
  type SessionMessage,
} from "@/repositories/session.repository";
import type { LineUserRow } from "@/repositories/types";
import { findBillContext } from "@/services/bill.service";
import { buildSystemPrompt, isIgnoreReply } from "./system-prompt";
import { executeTool, type ToolContext } from "./tool-executor";
import { toolDeclarations } from "./tools";

/** ข้อความยาว ๆ ไม่ได้ช่วยให้เข้าใจดีขึ้น แต่กินโควตา (LLM Design §3) */
const MAX_INPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 1_000;

export type AgentInput = {
  text: string;
  lineGroupId: string;
  lineUserId: string;
  user: LineUserRow;
  client: GeminiClient;
  now?: Date;
  /** ข้อความนี้มาทางโหมดฟัง ไม่ได้ขึ้นต้นด้วย wake word (spec §6) */
  listening?: boolean;
};

export type AgentReply = {
  messages: LineMessage[];
  /**
   * ข้อความนี้ไม่ได้คุยกับบอท หรือตีความไม่ออกในโหมดฟัง — ผู้เรียกเอาไปปิดโหมดฟัง
   *
   * งานที่ "สำเร็จ" ไม่ปิดโหมดฟังแล้ว เพราะสำเร็จคือกรณีปกติที่สุด
   * ถ้าปิดทุกครั้งที่สำเร็จ ผู้ใช้ต้องเรียก "บอทจ๋า" ใหม่แทบทุกประโยค (spec §6)
   */
  ignored: boolean;
};

function toContents(history: SessionMessage[], userText: string): Content[] {
  return [
    ...history.map((message) => ({
      role: message.role,
      parts: [{ text: message.text }],
    })),
    { role: "user", parts: [{ text: userText }] },
  ];
}

async function buildGameContext(lineGroupId: string, user: LineUserRow) {
  const game = await findOpenGame(lineGroupId);
  if (!game) return null;

  const [joinedCount, status] = await Promise.all([
    countJoinedPlayers(game.id),
    findPlayerStatus(game.id, user.id),
  ]);

  return {
    game,
    joinedCount,
    isCreator: game.created_by === user.id,
    hasJoined: status === "joined",
  };
}

/**
 * คุยกับ Gemini แล้วเรียก tool ตามที่ขอ วนได้สูงสุด MAX_TOOL_LOOPS รอบ (LLM Design §3)
 *
 * ทางที่ล้มเหลวจบต่างกันตามว่ามาทางไหน
 * - มี wake word: จบที่เมนูปุ่ม ผู้ใช้เรียกบอทมาเอง ต้องได้อะไรกลับไปเสมอ
 * - โหมดฟัง: เงียบ เพราะไม่รู้ด้วยซ้ำว่าข้อความนั้นคุยกับบอทหรือเปล่า (spec §6)
 */
export async function runAgent(input: AgentInput): Promise<AgentReply> {
  const userText = input.text.slice(0, MAX_INPUT_LENGTH);
  const toolContext: ToolContext = { lineGroupId: input.lineGroupId, user: input.user };
  const attachments: LineMessage[] = [];

  try {
    const [history, openGame, openBill] = await Promise.all([
      loadSessionMessages(input.lineGroupId, input.lineUserId),
      buildGameContext(input.lineGroupId, input.user),
      findBillContext(input.lineGroupId, input.user.id),
    ]);

    const systemInstruction = buildSystemPrompt({
      displayName: input.user.display_name,
      openGame,
      openBill,
      ...(input.now ? { now: input.now } : {}),
      ...(input.listening ? { listening: true } : {}),
    });

    const contents = toContents(history, userText);
    let replyText = "";

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop += 1) {
      const turn = await input.client.generate({
        systemInstruction,
        contents,
        tools: toolDeclarations,
      });

      if (turn.calls.length === 0) {
        replyText = turn.text.trim().slice(0, MAX_OUTPUT_LENGTH);
        break;
      }

      // ส่ง content ดิบกลับไปทั้งก้อน เพื่อให้ thoughtSignature ของ Gemini 3 ติดไปด้วย
      contents.push(
        turn.content ?? {
          role: "model",
          parts: turn.calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })),
        },
      );

      const outcomes = [];
      for (const call of turn.calls) {
        const outcome = await executeTool(call.name, call.args, toolContext);
        attachments.push(...outcome.messages);
        outcomes.push({ name: call.name, response: outcome.result });
      }

      contents.push({
        role: "user",
        parts: outcomes.map((outcome) => ({
          functionResponse: {
            name: outcome.name,
            response: outcome.response as Record<string, unknown>,
          },
        })),
      });
    }

    // โหมดฟัง: LLM บอกว่าข้อความนี้ไม่ได้คุยกับบอท เงียบและปิดโหมดฟัง
    // ไม่บันทึกลง history ด้วย จะได้ไม่เอาบทสนทนาของคนอื่นไปปนบริบทของบอท
    if (input.listening && attachments.length === 0 && isIgnoreReply(replyText)) {
      return { messages: [], ignored: true };
    }

    // ไม่มีทั้งข้อความและปุ่ม แปลว่าไปไม่สุด เช่น วน tool ครบแล้วยังไม่ได้คำตอบ
    if (!replyText && attachments.length === 0) return giveUp(input);

    await rememberTurn(input, history, userText, replyText);
    return { messages: buildReply(replyText, attachments), ignored: false };
  } catch (error) {
    console.error("[llm] failed:", formatErrorForLog(error));

    // งานบางอย่างทำไปแล้วก่อนพัง ต้องส่งการ์ดให้ผู้ใช้เห็น ไม่งั้นจะมีรายการค้างที่ไม่มีปุ่มกด
    if (attachments.length > 0) {
      await rememberTurn(input, [], userText, "").catch(() => {});
      return { messages: buildReply("นี่คือผลล่าสุดครับ 👇", attachments), ignored: false };
    }
    return giveUp(input);
  }
}

/** ตีความไม่ได้หรือพังไปเลย มีทางเข้าสองทางจึงยอมแพ้คนละแบบ */
function giveUp(input: AgentInput): AgentReply {
  if (input.listening) return { messages: [], ignored: true };
  return { messages: [fallbackMenu()], ignored: false };
}

/** ข้อความจาก LLM + การ์ด รวมแล้วต้องไม่เกินที่ LINE ส่งได้ต่อครั้ง เก็บการ์ดใบล่าสุดไว้ก่อน */
function buildReply(replyText: string, attachments: LineMessage[]): LineMessage[] {
  const head = replyText ? [text(replyText)] : [];
  const room = MAX_REPLY_MESSAGES - head.length;
  return [...head, ...attachments.slice(-room)];
}

async function rememberTurn(
  input: AgentInput,
  history: SessionMessage[],
  userText: string,
  replyText: string,
): Promise<void> {
  await saveSessionMessages(input.lineGroupId, input.lineUserId, [
    ...history,
    { role: "user", text: userText },
    ...(replyText ? [{ role: "model" as const, text: replyText }] : []),
  ]);
}

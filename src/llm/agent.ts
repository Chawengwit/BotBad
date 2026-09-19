import type { Content } from "@google/genai";
import type { GeminiClient } from "@/lib/gemini";
import { MAX_TOOL_LOOPS } from "@/lib/gemini";
import { MAX_REPLY_MESSAGES, type LineMessage } from "@/lib/line";
import { formatErrorForLog } from "@/lib/log";
import { fallbackMenu, text } from "@/line/messages";
import {
  loadSessionMessages,
  saveSessionMessages,
  type SessionMessage,
} from "@/repositories/session.repository";
import type { LineUserRow } from "@/repositories/types";
import { findBillContext } from "@/services/bill.service";
import { hasJoined, loadOpenRounds } from "@/services/round.service";
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
  /** ข้อความนี้คือชื่อบิลกับรายการ ตอบต่อจากปุ่ม "สร้างบิลใหม่" title ว่าง = ยังไม่ได้ตั้งชื่อ */
  newBill?: { pendingId: string; title: string };
};

/**
 * ข้อความที่จะตอบ ว่างเปล่า = เงียบ
 *
 * ไม่มีสัญญาณ "ปิดโหมดฟัง" อีกแล้ว เพราะเหตุการณ์เดียวไม่ควรจบบทสนทนา
 * ทั้งงานที่สำเร็จและข้อความที่ไม่ได้คุยกับบอท ปล่อยให้หน้าต่าง 2 นาทีหมดอายุเอง (spec §6)
 */
export type AgentReply = {
  messages: LineMessage[];
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

/** ทุกรอบที่เปิดอยู่ พร้อมบอกว่าคนที่คุยด้วยเปิดรอบไหนและลงรอบไหน (PRP multi-open-rounds §6) */
async function buildRoundsContext(lineGroupId: string, user: LineUserRow) {
  const rounds = await loadOpenRounds(lineGroupId);

  return rounds.map((round) => ({
    game: round.game,
    joinedCount: round.players.length,
    isCreator: round.game.created_by === user.id,
    hasJoined: hasJoined(round, user.id),
  }));
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
  const toolContext: ToolContext = {
    lineGroupId: input.lineGroupId,
    user: input.user,
    ...(input.newBill ? { billPendingId: input.newBill.pendingId } : {}),
  };
  const attachments: LineMessage[] = [];

  try {
    const [history, openGames, openBill] = await Promise.all([
      loadSessionMessages(input.lineGroupId, input.lineUserId),
      buildRoundsContext(input.lineGroupId, input.user),
      findBillContext(input.lineGroupId, input.user.id),
    ]);

    const systemInstruction = buildSystemPrompt({
      displayName: input.user.display_name,
      openGames,
      openBill,
      ...(input.now ? { now: input.now } : {}),
      ...(input.listening ? { listening: true } : {}),
      ...(input.newBill ? { newBill: { title: input.newBill.title } } : {}),
    });

    const contents = toContents(history, userText);
    let replyText = "";
    let systemReply = false;

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
        if (outcome.systemReply) systemReply = true;
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
      return { messages: [] };
    }

    // ไม่มีทั้งข้อความและปุ่ม แปลว่าไปไม่สุด เช่น วน tool ครบแล้วยังไม่ได้คำตอบ
    if (!replyText && attachments.length === 0) return giveUp(input);

    // ลงชื่อ ถอนชื่อ จ่ายเงิน ตอบด้วยข้อความของระบบอย่างเดียว LLM จะได้พูดว่าทำแล้วเองไม่ได้
    // จำข้อความของระบบไว้เป็นคำตอบของบอท ถ้าบอทถามว่าบิลไหน ข้อความถัดไปจะได้ต่อเรื่องถูก
    if (systemReply) {
      const spoken = attachments.map((message) => (message.type === "text" ? message.text : message.altText));
      await rememberTurn(input, history, userText, spoken.join("\n"));
      return { messages: buildReply("", attachments) };
    }

    await rememberTurn(input, history, userText, replyText);
    return { messages: buildReply(replyText, attachments) };
  } catch (error) {
    console.error("[llm] failed:", formatErrorForLog(error));

    // งานบางอย่างทำไปแล้วก่อนพัง ต้องส่งการ์ดให้ผู้ใช้เห็น ไม่งั้นจะมีรายการค้างที่ไม่มีปุ่มกด
    if (attachments.length > 0) {
      await rememberTurn(input, [], userText, "").catch(() => {});
      return { messages: buildReply("นี่คือผลล่าสุดครับ 👇", attachments) };
    }
    return giveUp(input);
  }
}

/** ตีความไม่ได้หรือพังไปเลย มีทางเข้าสองทางจึงยอมแพ้คนละแบบ */
function giveUp(input: AgentInput): AgentReply {
  // โหมดฟัง: เงียบ เพราะไม่รู้ด้วยซ้ำว่าข้อความนั้นคุยกับบอทหรือเปล่า
  // มี wake word: ต้องได้อะไรกลับไปเสมอ เพราะผู้ใช้เรียกบอทมาเอง
  return { messages: input.listening ? [] : [fallbackMenu()] };
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

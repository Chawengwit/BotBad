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
import type { UserRow } from "@/repositories/types";
import { buildSystemPrompt } from "./system-prompt";
import { executeTool, type ToolContext } from "./tool-executor";
import { toolDeclarations } from "./tools";

/** ข้อความยาว ๆ ไม่ได้ช่วยให้เข้าใจดีขึ้น แต่กินโควตา (LLM Design §3) */
const MAX_INPUT_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 1_000;

export type AgentInput = {
  text: string;
  lineGroupId: string;
  lineUserId: string;
  user: UserRow;
  client: GeminiClient;
  now?: Date;
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

async function buildPromptContext(lineGroupId: string, user: UserRow) {
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
 * ทุกทางที่ล้มเหลวจบที่เมนูปุ่ม ไม่ปล่อยให้เงียบ
 */
export async function runAgent(input: AgentInput): Promise<LineMessage[]> {
  const userText = input.text.slice(0, MAX_INPUT_LENGTH);
  const toolContext: ToolContext = { lineGroupId: input.lineGroupId, user: input.user };
  const attachments: LineMessage[] = [];

  try {
    const [history, openGame] = await Promise.all([
      loadSessionMessages(input.lineGroupId, input.lineUserId),
      buildPromptContext(input.lineGroupId, input.user),
    ]);

    const systemInstruction = buildSystemPrompt({
      displayName: input.user.display_name,
      openGame,
      ...(input.now ? { now: input.now } : {}),
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

    // ไม่มีทั้งข้อความและปุ่ม แปลว่าไปไม่สุด เช่น วน tool ครบแล้วยังไม่ได้คำตอบ
    if (!replyText && attachments.length === 0) return [fallbackMenu()];

    await rememberTurn(input, history, userText, replyText);
    return buildReply(replyText, attachments);
  } catch (error) {
    console.error("[llm] failed:", formatErrorForLog(error));

    // งานบางอย่างทำไปแล้วก่อนพัง ต้องส่งการ์ดให้ผู้ใช้เห็น ไม่งั้นจะมีรายการค้างที่ไม่มีปุ่มกด
    if (attachments.length > 0) {
      await rememberTurn(input, [], userText, "").catch(() => {});
      return buildReply("นี่คือผลล่าสุดครับ 👇", attachments);
    }
    return [fallbackMenu()];
  }
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

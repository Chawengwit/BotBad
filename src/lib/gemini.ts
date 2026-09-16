import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { getGeminiConfig } from "./env";

/** วนเรียก tool ได้ไม่เกินเท่านี้ต่อข้อความหนึ่งครั้ง (LLM Design §3) */
export const MAX_TOOL_LOOPS = 3;
export const GEMINI_TIMEOUT_MS = 8_000;
const TEMPERATURE = 0.2;
const MAX_OUTPUT_TOKENS = 512;

export type GeminiCall = {
  name: string;
  args: Record<string, unknown>;
};

export type GeminiTurn = {
  text: string;
  calls: GeminiCall[];
  /**
   * Content ดิบของฝั่ง model
   * ต้องส่งกลับไปทั้งก้อนในรอบถัดไป เพราะ Gemini 3 บังคับให้มี thoughtSignature ติดไปกับ functionCall
   * ถ้าประกอบ part ขึ้นใหม่เองจะโดนปฏิเสธ 400 (ทดสอบจริง 2026-09-16)
   */
  content?: Content;
};

/** แยก interface ไว้เพื่อให้เทสสลับตัวปลอมเข้ามาได้โดยไม่ต้องยิง Gemini จริง */
export type GeminiClient = {
  generate(input: {
    systemInstruction: string;
    contents: Content[];
    tools: FunctionDeclaration[];
  }): Promise<GeminiTurn>;
};

export function createGeminiClient(): GeminiClient {
  const { apiKey, model } = getGeminiConfig();
  const ai = new GoogleGenAI({ apiKey });

  return {
    async generate({ systemInstruction, contents, tools }) {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          tools: [{ functionDeclarations: tools }],
          // เรียก tool เองทั้งหมด จะได้ validate args และเช็กสิทธิ์ก่อนทุกครั้ง (LLM Design §3)
          automaticFunctionCalling: { disable: true },
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // ปิดโหมดคิดยาว วัดจริงแล้วต่างกันมาก (53 วินาที → 1.4 วินาที)
          // งานนี้แค่ตีความประโยคสั้น ๆ ไม่ต้องใช้การคิดหลายชั้น และ replyToken ของ LINE รอไม่ได้
          thinkingConfig: { thinkingBudget: 0 },
          abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        },
      });

      const content = response.candidates?.[0]?.content;

      return {
        text: response.text ?? "",
        calls: (response.functionCalls ?? []).map((call) => ({
          name: call.name ?? "",
          args: (call.args ?? {}) as Record<string, unknown>,
        })),
        ...(content ? { content } : {}),
      };
    },
  };
}

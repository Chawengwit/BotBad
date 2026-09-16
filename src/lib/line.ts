import { truncate } from "./log";

const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const REPLY_TIMEOUT_MS = 5_000;
const MAX_ERROR_DETAIL_LENGTH = 300;

export type TextMessage = { type: "text"; text: string };

export async function replyMessages(
  replyToken: string,
  messages: TextMessage[],
  accessToken: string,
): Promise<void> {
  const response = await fetch(LINE_REPLY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages }),
    // replyToken ของ LINE มีอายุสั้น ถ้า API ค้างต้องเลิกรอ ไม่ให้ webhook ค้างตาม
    signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LINE reply failed: ${response.status} ${truncate(detail, MAX_ERROR_DETAIL_LENGTH)}`);
  }
}

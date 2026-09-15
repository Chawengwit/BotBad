const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";

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
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LINE reply failed: ${response.status} ${detail}`);
  }
}

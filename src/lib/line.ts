import { truncate } from "./log";

const LINE_API = "https://api.line.me/v2/bot";
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_ERROR_DETAIL_LENGTH = 300;

export type PostbackAction = {
  type: "postback";
  label: string;
  data: string;
  displayText?: string;
};

export type DatetimePickerAction = {
  type: "datetimepicker";
  label: string;
  data: string;
  mode: "date" | "time";
  initial?: string;
  min?: string;
  max?: string;
};

/** กดแล้วส่งข้อความนั้นแทนผู้ใช้ ใช้กับเมนูคำสั่งสำรอง */
export type TextMessageAction = {
  type: "message";
  label: string;
  text: string;
};

export type MessageAction = PostbackAction | DatetimePickerAction | TextMessageAction;

export type QuickReply = { items: { type: "action"; action: MessageAction }[] };

export type TextMessage = {
  type: "text";
  text: string;
  /** ปุ่มลัดเหนือช่องพิมพ์ ใช้ได้ทั้งในกลุ่มและแชทเดี่ยว รองรับได้ถึง 13 ปุ่ม */
  quickReply?: QuickReply;
};

export type ButtonsMessage = {
  type: "template";
  altText: string;
  template: {
    type: "buttons";
    text: string;
    actions: MessageAction[];
  };
};

export type LineMessage = TextMessage | ButtonsMessage;

async function callLineApi(path: string, init: RequestInit, accessToken: string): Promise<Response> {
  const response = await fetch(`${LINE_API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${accessToken}`,
    },
    // replyToken ของ LINE มีอายุสั้น ถ้า API ค้างต้องเลิกรอ ไม่ให้ webhook ค้างตาม
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LINE ${path} failed: ${response.status} ${truncate(detail, MAX_ERROR_DETAIL_LENGTH)}`);
  }

  return response;
}

export async function replyMessages(
  replyToken: string,
  messages: LineMessage[],
  accessToken: string,
): Promise<void> {
  await callLineApi(
    "/message/reply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyToken, messages }),
    },
    accessToken,
  );
}

/**
 * ชื่อที่แสดงของสมาชิกในกลุ่ม
 * ต้องใช้ endpoint ของกลุ่ม เพราะ /profile ใช้ได้เฉพาะคนที่เพิ่มบอทเป็นเพื่อนแล้ว
 */
export async function getGroupMemberDisplayName(
  groupId: string,
  userId: string,
  accessToken: string,
): Promise<string | null> {
  try {
    const response = await callLineApi(
      `/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`,
      { method: "GET" },
      accessToken,
    );
    const profile = (await response.json()) as { displayName?: unknown };
    return typeof profile.displayName === "string" && profile.displayName.length > 0
      ? profile.displayName
      : null;
  } catch {
    // ดึงชื่อไม่ได้ไม่ควรทำให้ทั้งคำสั่งล้ม ให้ผู้เรียกใช้ชื่อสำรองแทน
    return null;
  }
}

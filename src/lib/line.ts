import { formatErrorForLog, truncate } from "./log";

const LINE_API = "https://api.line.me/v2/bot";
/** LINE รับได้สูงสุด 5 ข้อความต่อการ reply หนึ่งครั้ง เกินนี้จะโดนปฏิเสธทั้งชุด */
export const MAX_REPLY_MESSAGES = 5;
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
  mode: "date" | "time" | "datetime";
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

/** เปิดลิงก์ภายนอก ใช้กับลิงก์แผนที่บนการ์ด */
export type UriAction = {
  type: "uri";
  label?: string;
  uri: string;
};

export type MessageAction = PostbackAction | DatetimePickerAction | TextMessageAction | UriAction;

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

/**
 * Flex Message — ชุดย่อยของ schema จริงเท่าที่บอทใช้ (spec §23)
 * จงใจไม่ประกาศทุก property ที่ LINE รองรับ จะได้ไม่ต้องดูแล type ก้อนใหญ่ที่ไม่มีใครเรียก
 */
export type FlexText = {
  type: "text";
  text: string;
  size?: string;
  color?: string;
  weight?: "regular" | "bold";
  align?: "start" | "end" | "center";
  wrap?: boolean;
  flex?: number;
  margin?: string;
  action?: MessageAction;
};

export type FlexSeparator = {
  type: "separator";
  margin?: string;
  color?: string;
};

export type FlexButton = {
  type: "button";
  action: MessageAction;
  style?: "primary" | "secondary" | "link";
  color?: string;
  height?: "sm" | "md";
};

export type FlexBox = {
  type: "box";
  layout: "vertical" | "horizontal" | "baseline";
  contents: FlexComponent[];
  spacing?: string;
  margin?: string;
  paddingAll?: string;
  paddingTop?: string;
  backgroundColor?: string;
  cornerRadius?: string;
  flex?: number;
};

export type FlexComponent = FlexBox | FlexText | FlexSeparator | FlexButton;

export type FlexBubble = {
  type: "bubble";
  size?: "nano" | "micro" | "kilo" | "mega" | "giga";
  header?: FlexBox;
  body?: FlexBox;
  footer?: FlexBox;
};

export type FlexMessage = {
  type: "flex";
  /** ข้อความสำรองที่โผล่ใน notification และในเครื่องที่แสดง Flex ไม่ได้ */
  altText: string;
  contents: FlexBubble;
};

export type LineMessage = TextMessage | ButtonsMessage | FlexMessage;

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
  if (messages.length > MAX_REPLY_MESSAGES) {
    console.warn(`[line] trimmed reply from ${messages.length} to ${MAX_REPLY_MESSAGES} messages`);
  }
  const trimmed = messages.slice(0, MAX_REPLY_MESSAGES);

  await callLineApi(
    "/message/reply",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyToken, messages: trimmed }),
    },
    accessToken,
  );
}

/**
 * ส่งข้อความเข้ากลุ่มโดยไม่มี replyToken ใช้กับ cron เท่านั้น (PRP guests-split-bills-and-digest §6)
 *
 * ต่างจาก reply ตรงที่ **ไม่ฟรี** และนับตามจำนวนคนในกลุ่ม ไม่ใช่ตามจำนวนข้อความ
 * ส่งเข้ากลุ่ม 30 คนครั้งเดียว = ตัดโควตา 30 ข้อความ
 */
export async function pushMessages(
  to: string,
  messages: LineMessage[],
  accessToken: string,
): Promise<void> {
  await callLineApi(
    "/message/push",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, messages: messages.slice(0, MAX_REPLY_MESSAGES) }),
    },
    accessToken,
  );
}

export type MessageQuota = {
  /** เพดานของเดือนนี้ null = ไม่จำกัด */
  limit: number | null;
  used: number;
};

/**
 * เพดานและยอดที่ใช้ไปของเดือนนี้ เรียกแล้วไม่เสียโควตา
 * ใช้เป็นเบรกมือก่อน push (PRP §6.4)
 */
export async function getMessageQuota(accessToken: string): Promise<MessageQuota> {
  const [quota, consumption] = await Promise.all([
    callLineApi("/message/quota", { method: "GET" }, accessToken).then(
      (response) => response.json() as Promise<{ type?: string; value?: number }>,
    ),
    callLineApi("/message/quota/consumption", { method: "GET" }, accessToken).then(
      (response) => response.json() as Promise<{ totalUsage?: number }>,
    ),
  ]);

  return {
    limit: quota.type === "limited" && typeof quota.value === "number" ? quota.value : null,
    used: consumption.totalUsage ?? 0,
  };
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
  } catch (error) {
    // ดึงชื่อไม่ได้ไม่ควรทำให้ทั้งคำสั่งล้ม แต่ต้องรู้ เพราะถ้า token หมดอายุ
    // สมาชิกทุกคนจะกลายเป็นชื่อสำรองเหมือนกันหมดโดยไม่มีสัญญาณอะไรเลย
    console.error("[line] cannot read display name:", formatErrorForLog(error, [accessToken]));
    return null;
  }
}

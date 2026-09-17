import { createHmac } from "node:crypto";

export const SECRET = "test-channel-secret";
export const TOKEN = "test-access-token";

export const WEBHOOK_URL = "http://localhost/api/line/webhook";

export const sign = (body: string | Buffer, secret: string = SECRET) =>
  createHmac("sha256", secret).update(body).digest("base64");

export type MakeRequestOptions = {
  /** null = ไม่ส่ง header signature เลย, undefined = เซ็นให้อัตโนมัติ */
  signature?: string | null;
  headers?: HeadersInit;
};

export function makeRequest(body: unknown, options: MakeRequestOptions = {}): Request {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = options.signature === undefined ? sign(raw) : options.signature;

  const headers = new Headers({ "content-type": "application/json", ...options.headers });
  if (signature !== null) headers.set("x-line-signature", signature);

  return new Request(WEBHOOK_URL, { method: "POST", headers, body: raw });
}

/** สร้าง Request ที่ body พังกลางคัน เหมือน client ตัดสายระหว่างอัปโหลด */
export function makeBrokenBodyRequest(signature: string = "AAAA"): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"destination"'));
      controller.error(new Error("aborted: client reset connection"));
    },
  });

  return new Request(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-line-signature": signature },
    body: stream,
    // @ts-expect-error duplex is required by undici for a stream body but missing from the DOM types
    duplex: "half",
  });
}

export const group = { type: "group", groupId: "C123", userId: "U123" } as const;
export const room = { type: "room", roomId: "R123", userId: "U123" } as const;
export const oneToOne = { type: "user", userId: "U123" } as const;

export const textEvent = (text: string, source: object | undefined, replyToken = "reply-token-1") => ({
  type: "message",
  replyToken,
  ...(source ? { source } : {}),
  message: { type: "text", id: "1", text },
});

/**
 * ตัวช่วยอ่านข้อความที่บอทส่งออกไป โดยไม่ต้องสนใจว่าเป็น text, buttons template หรือ Flex
 * รวมไว้ที่เดียวเพราะทุกชุดเทสต้องการเหมือนกัน และรูปแบบข้อความเปลี่ยนได้เรื่อย ๆ
 */

type AnyAction = { label?: string; data?: string; uri?: string };
type AnyComponent = {
  type: string;
  text?: string;
  layout?: string;
  contents?: AnyComponent[];
  action?: AnyAction;
};
type AnyMessage = {
  type: string;
  text?: string;
  altText?: string;
  quickReply?: { items: { action: AnyAction }[] };
  template?: { text?: string; actions?: AnyAction[] };
  contents?: { header?: AnyComponent; body?: AnyComponent; footer?: AnyComponent };
};

function walk(component: AnyComponent | undefined, visit: (node: AnyComponent) => void): void {
  if (!component) return;
  visit(component);
  for (const child of component.contents ?? []) walk(child, visit);
}

function flexParts(message: AnyMessage): AnyComponent[] {
  const parts: AnyComponent[] = [];
  for (const section of [message.contents?.header, message.contents?.body, message.contents?.footer]) {
    walk(section, (node) => parts.push(node));
  }
  return parts;
}

/**
 * แปลง component ของ Flex เป็นบรรทัดข้อความอย่างที่ผู้ใช้เห็นจริง
 * box แนวนอนอยู่บรรทัดเดียวกัน box แนวตั้งขึ้นบรรทัดใหม่
 * ถ้าแบนทุกอย่างเป็นบรรทัดละชิ้น เทสจะมองไม่เห็นว่า "รวม" กับ "600.00" อยู่แถวเดียวกัน
 */
function render(component: AnyComponent | undefined): string[] {
  if (!component) return [];

  if (component.type === "box") {
    const lines = (component.contents ?? []).flatMap(render);
    return component.layout === "horizontal" ? [lines.join(" ")] : lines;
  }

  // ปุ่มไม่นับเป็นเนื้อความ หา data ของปุ่มใช้ buttonData แทน
  return typeof component.text === "string" ? [component.text] : [];
}

/** ข้อความทั้งหมดในข้อความเดียว ต่อกันด้วยขึ้นบรรทัดใหม่ */
export function messageText(message: unknown): string {
  const any = message as AnyMessage;

  if (any.type === "text") return any.text ?? "";
  if (any.type === "template") return any.template?.text ?? "";

  return [any.contents?.header, any.contents?.body, any.contents?.footer]
    .flatMap(render)
    .join("\n");
}

export function messageTexts(messages: unknown[]): string {
  return messages.map(messageText).join("\n");
}

/** data ของปุ่มชื่อนี้ ไม่ว่าจะอยู่ใน template, quick reply หรือ footer ของ Flex */
export function buttonData(messages: unknown[], label: string): string | undefined {
  for (const message of messages as AnyMessage[]) {
    const actions: AnyAction[] = [
      ...(message.template?.actions ?? []),
      ...(message.quickReply?.items ?? []).map((item) => item.action),
      ...flexParts(message)
        .map((node) => node.action)
        .filter((action): action is AnyAction => action !== undefined),
    ];

    const found = actions.find((action) => action.label === label);
    if (found?.data) return found.data;
  }
  return undefined;
}

/** บอทแนบปุ่มมากับข้อความนี้ไหม (spec §23) */
export function hasButtons(message: unknown): boolean {
  const any = message as AnyMessage;

  if (any.type === "template") return true;
  if (any.quickReply !== undefined) return true;
  return flexParts(any).some((node) => node.type === "button");
}

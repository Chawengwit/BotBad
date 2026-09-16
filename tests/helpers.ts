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

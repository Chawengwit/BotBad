import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ตรวจ x-line-signature: base64(HMAC-SHA256(channelSecret, rawBody))
 * ต้องใช้ raw body ตามที่ LINE ส่งมา ห้าม parse แล้ว stringify ใหม่
 */
export function verifyLineSignature(
  rawBody: string,
  signature: string | null,
  channelSecret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody, "utf8").digest();

  let received: Buffer;
  try {
    received = Buffer.from(signature, "base64");
  } catch {
    return false;
  }

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

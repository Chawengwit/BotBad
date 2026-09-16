import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * ตรวจ x-line-signature: base64(HMAC-SHA256(channelSecret, rawBody))
 * ต้องใช้ raw body ตามที่ LINE ส่งมา ห้าม parse แล้ว stringify ใหม่
 */
export function verifyLineSignature(
  rawBody: Buffer | string,
  signature: string | null,
  channelSecret: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody).digest();
  // Buffer.from(..., "base64") ไม่ throw แม้ string จะไม่ใช่ base64 (ตัวที่ decode ไม่ได้จะถูกข้าม)
  // จึงต้องเทียบความยาวก่อน timingSafeEqual
  const received = Buffer.from(signature, "base64");

  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "@/lib/line-signature";

const SECRET = "test-channel-secret";
const sign = (body: string | Buffer, secret = SECRET) =>
  createHmac("sha256", secret).update(body).digest("base64");

describe("verifyLineSignature", () => {
  const body = JSON.stringify({ destination: "U123", events: [] });

  it("accepts a valid signature", () => {
    expect(verifyLineSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts a valid signature for a Thai body", () => {
    const thai = JSON.stringify({ text: "บอทจ๋า เปิดตี" });
    expect(verifyLineSignature(thai, sign(thai), SECRET)).toBe(true);
  });

  it("treats a Buffer body the same as its utf-8 string", () => {
    const thai = JSON.stringify({ text: "บอทจ๋า ลงชื่อ" });
    const buffer = Buffer.from(thai, "utf8");
    expect(verifyLineSignature(buffer, sign(thai), SECRET)).toBe(true);
    expect(verifyLineSignature(buffer, sign(buffer), SECRET)).toBe(true);
  });

  it("rejects a missing signature", () => {
    expect(verifyLineSignature(body, null, SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    expect(verifyLineSignature(body, sign(body, "other-secret"), SECRET)).toBe(false);
  });

  it("rejects when the body was modified", () => {
    expect(verifyLineSignature(`${body} `, sign(body), SECRET)).toBe(false);
  });

  it("rejects signatures that decode to the wrong length", () => {
    expect(verifyLineSignature(body, "not-a-signature", SECRET)).toBe(false);
    expect(verifyLineSignature(body, "", SECRET)).toBe(false);
    expect(verifyLineSignature(body, sign(body).slice(0, 20), SECRET)).toBe(false);
  });

  it("rejects a signature whose last byte differs", () => {
    const valid = Buffer.from(sign(body), "base64");
    const tampered = Buffer.from(valid);
    tampered[31] = (tampered[31]! + 1) % 256;
    expect(verifyLineSignature(body, tampered.toString("base64"), SECRET)).toBe(false);
  });
});

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "@/lib/line-signature";

const SECRET = "test-channel-secret";
const sign = (body: string, secret = SECRET) =>
  createHmac("sha256", secret).update(body, "utf8").digest("base64");

describe("verifyLineSignature", () => {
  const body = JSON.stringify({ destination: "U123", events: [] });

  it("accepts a valid signature", () => {
    expect(verifyLineSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("accepts a valid signature for a Thai body", () => {
    const thai = JSON.stringify({ text: "บอทจ๋า เปิดตี" });
    expect(verifyLineSignature(thai, sign(thai), SECRET)).toBe(true);
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

  it("rejects garbage and wrong-length signatures", () => {
    expect(verifyLineSignature(body, "not-a-signature", SECRET)).toBe(false);
    expect(verifyLineSignature(body, "", SECRET)).toBe(false);
  });
});

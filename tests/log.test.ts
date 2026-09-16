import { describe, expect, it } from "vitest";
import { formatErrorForLog, MIN_SECRET_LENGTH, truncate } from "@/lib/log";

describe("formatErrorForLog", () => {
  it("formats an Error as name: message", () => {
    expect(formatErrorForLog(new TypeError("boom"))).toBe("TypeError: boom");
  });

  it("formats non-errors too", () => {
    expect(formatErrorForLog("plain string")).toBe("plain string");
  });

  it("includes error.cause, where fetch hides the real reason", () => {
    const error = new TypeError("fetch failed", { cause: new Error("ECONNREFUSED 127.0.0.1:443") });

    const logged = formatErrorForLog(error);

    expect(logged).toContain("fetch failed");
    expect(logged).toContain("ECONNREFUSED");
  });

  it("follows a nested cause chain and a non-error cause", () => {
    const error = new Error("outer", { cause: new Error("middle", { cause: "inner reason" }) });

    const logged = formatErrorForLog(error);

    expect(logged).toContain("outer");
    expect(logged).toContain("middle");
    expect(logged).toContain("inner reason");
  });

  it("redacts a secret that leaked into the message", () => {
    const token = "line-access-token-value";
    const error = new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`);

    const logged = formatErrorForLog(error, [token]);

    expect(logged).not.toContain(token);
    expect(logged).toContain("[redacted]");
  });

  it("redacts a secret hidden in error.cause", () => {
    const token = "line-access-token-value";
    const error = new Error("request failed", { cause: new Error(`Bearer ${token}`) });

    expect(formatErrorForLog(error, [token])).not.toContain(token);
  });

  it("redacts every occurrence and every listed secret", () => {
    const token = "line-access-token-value";
    const secret = "line-channel-secret-value";
    const logged = formatErrorForLog(new Error(`${token} ${secret} ${token}`), [token, secret]);

    expect(logged).not.toContain(token);
    expect(logged).not.toContain(secret);
  });

  it("only skips secrets shorter than the minimum env length", () => {
    // env.ts บังคับความยาวขั้นต่ำเท่ากัน ค่าที่สั้นกว่านี้จึงเข้ามาเป็น secret ไม่ได้
    expect(MIN_SECRET_LENGTH).toBe(8);
    expect(formatErrorForLog(new Error("a short message"), ["a"])).toContain("a short message");
    expect(formatErrorForLog(new Error("keeps 12345678 out"), ["12345678"])).toContain("[redacted]");
  });

  it("truncates very long messages", () => {
    const logged = formatErrorForLog(new Error("x".repeat(5000)));
    expect(logged.length).toBeLessThanOrEqual(501);
    expect(logged.endsWith("…")).toBe(true);
  });
});

describe("truncate", () => {
  it("leaves short text alone", () => {
    expect(truncate("สั้น ๆ", 100)).toBe("สั้น ๆ");
  });

  it("does not leave a Thai tone mark without its consonant", () => {
    // ตัดตรงกลาง "ก่" พอดี ถ้าตัดดิบ ๆ จะเหลือไม้เอกลอย
    const cut = truncate("เปิดตีก่อน", 7);
    expect(cut).toBe("เปิดตีก…");
  });

  it("does not split a surrogate pair", () => {
    const cut = truncate("ab🏸cd", 3);
    expect(cut).toBe("ab…");
  });
});

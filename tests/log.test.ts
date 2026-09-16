import { describe, expect, it } from "vitest";
import { formatErrorForLog } from "@/lib/log";

describe("formatErrorForLog", () => {
  it("formats an Error as name: message", () => {
    expect(formatErrorForLog(new TypeError("boom"))).toBe("TypeError: boom");
  });

  it("formats non-errors too", () => {
    expect(formatErrorForLog("plain string")).toBe("plain string");
  });

  it("redacts a secret that leaked into the message", () => {
    const token = "line-access-token-value";
    const error = new TypeError(`Headers.append: "Bearer ${token}" is an invalid header value.`);

    const logged = formatErrorForLog(error, [token]);

    expect(logged).not.toContain(token);
    expect(logged).toContain("[redacted]");
  });

  it("redacts every occurrence", () => {
    const token = "line-access-token-value";
    const logged = formatErrorForLog(new Error(`${token} and ${token}`), [token]);
    expect(logged).not.toContain(token);
  });

  it("ignores short secrets so common words are not mangled", () => {
    expect(formatErrorForLog(new Error("a short message"), ["a"])).toContain("a short message");
  });

  it("truncates very long messages", () => {
    const logged = formatErrorForLog(new Error("x".repeat(5000)));
    expect(logged.length).toBeLessThanOrEqual(501);
    expect(logged.endsWith("…")).toBe(true);
  });
});

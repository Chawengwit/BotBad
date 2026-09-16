import { afterEach, describe, expect, it, vi } from "vitest";
import { getLineAccessToken, getLineChannelSecret, getLineEnv } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("LINE env validation", () => {
  it("returns both values when they are set", () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", "secret-value");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "token-value");

    expect(getLineEnv()).toEqual({
      LINE_CHANNEL_SECRET: "secret-value",
      LINE_CHANNEL_ACCESS_TOKEN: "token-value",
    });
  });

  it("trims padding that survives .env quoting", () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", "  secret-value\n");
    expect(getLineChannelSecret()).toBe("secret-value");
  });

  it.each([
    ["whitespace only", "   "],
    ["empty", ""],
    ["too short", "abc"],
    ["newline inside", "head\ntail-value"],
    ["space inside", "head tail-value"],
    ["carriage return inside", "head\rtail-value"],
    ["tab inside", "head\ttail-value"],
    // ไม่ต้องเทสต์ null byte เพราะ process.env ตัดค่าทิ้งตั้งแต่ตัว \0 อยู่แล้ว
  ])("rejects a token that is %s", (_label, value) => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", value);
    expect(() => getLineAccessToken()).toThrow(/LINE_CHANNEL_ACCESS_TOKEN/);
  });

  it("never puts the value into the error message", () => {
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", "head\nsuper-secret-tail");
    expect(() => getLineAccessToken()).toThrow(expect.not.stringContaining("super-secret-tail"));
  });

  it("names the variable that is wrong", () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", undefined);
    expect(() => getLineChannelSecret()).toThrow(/Invalid LINE_CHANNEL_SECRET: .+/);
  });

  it("reads the secret without needing the access token", () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", "secret-value");
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", undefined);

    expect(getLineChannelSecret()).toBe("secret-value");
    expect(() => getLineEnv()).toThrow(/LINE_CHANNEL_ACCESS_TOKEN/);
  });

  it("reports every broken variable at once", () => {
    vi.stubEnv("LINE_CHANNEL_SECRET", undefined);
    vi.stubEnv("LINE_CHANNEL_ACCESS_TOKEN", undefined);

    expect(() => getLineEnv()).toThrow(/LINE_CHANNEL_SECRET.*LINE_CHANNEL_ACCESS_TOKEN/s);
  });
});

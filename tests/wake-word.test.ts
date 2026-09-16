import { describe, expect, it } from "vitest";
import { hasWakeWord, WAKE_WORD } from "@/router/wake-word";

describe("hasWakeWord", () => {
  it("uses the wake word from the spec", () => {
    expect(WAKE_WORD).toBe("บอทจ๋า");
  });

  it.each([
    "บอทจ๋า เปิดตี",
    "บอทจ๋า ลงชื่อ",
    "บอทจ๋า คืนนี้ผมไปตีด้วยนะ",
    "บอทจ๋าเปิดตี",
    "  บอทจ๋า   ใครตีบ้าง  ",
    "บอทจ๋า",
  ])("accepts %j", (text) => {
    expect(hasWakeWord(text)).toBe(true);
  });

  it.each(["เปิดตี", "ลงชื่อ", "คืนนี้ใครตีบ้าง", "หวัดดี", "วันนี้ บอทจ๋า ไปไหม", "บอทจ", ""])(
    "ignores %j",
    (text) => {
      expect(hasWakeWord(text)).toBe(false);
    },
  );
});

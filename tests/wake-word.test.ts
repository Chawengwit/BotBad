import { describe, expect, it } from "vitest";
import { matchWakeWord } from "@/router/wake-word";

describe("matchWakeWord", () => {
  it.each([
    ["บอทจ๋า เปิดตี", "เปิดตี"],
    ["บอทจ๋า ลงชื่อ", "ลงชื่อ"],
    ["บอทจ๋า คืนนี้ผมไปตีด้วยนะ", "คืนนี้ผมไปตีด้วยนะ"],
    ["บอทจ๋าเปิดตี", "เปิดตี"],
    ["  บอทจ๋า   ใครตีบ้าง  ", "ใครตีบ้าง"],
    ["บอทจ๋า", ""],
  ])("matches %j", (text, command) => {
    expect(matchWakeWord(text)).toEqual({ matched: true, command });
  });

  it.each(["เปิดตี", "ลงชื่อ", "คืนนี้ใครตีบ้าง", "หวัดดี", "วันนี้ บอทจ๋า ไปไหม", ""])(
    "ignores %j",
    (text) => {
      expect(matchWakeWord(text)).toEqual({ matched: false });
    },
  );
});

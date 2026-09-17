import { describe, expect, it } from "vitest";
import { easterEggReply } from "@/router/easter-eggs";

describe("easterEggReply", () => {
  it.each([
    "ใครน่ารักที่สุด",
    "ใครสวยที่สุด",
    "ใครสวยที่สุด กิ้ฟ",
    "  ใครน่ารักที่สุดในก๊วน  ",
    "ว่าแต่ใครน่ารักที่สุดเนี่ย",
  ])("answers %j with the name", (text) => {
    expect(easterEggReply(text)).toBe("กิ้ฟ");
  });

  it.each([
    "กิ้ฟน่ารักมั้ย",
    "กิ๊ฟน่ารักมั้ย",
    "กิฟน่ารักไหม",
    "กิ๊ฟท์น่ารักมั้ย",
    "give น่ารักมั้ย",
    "Give น่ารักป่าว",
    "เจ้าหมาน่ารักมั้ย",
    "บอทว่ากิ้ฟน่ารักมั้ยครับ",
  ])("answers %j with the compliment", (text) => {
    expect(easterEggReply(text)).toBe("น่ารักที่สุด");
  });

  it("mirrors the compliment that was asked", () => {
    expect(easterEggReply("กิ้ฟสวยมั้ย")).toBe("สวยที่สุด");
  });

  it.each([
    "เชวงน่ารักมั้ย", // ถามถึงคนอื่น ต้องปล่อยให้ LLM ตอบ
    "วิทสวยไหม",
    "กิ้ฟน่ารักมาก", // บอกเล่า ไม่ใช่คำถาม
    "forgive น่ารักมั้ย", // give ที่อยู่กลางคำอื่น
    "เปิดตี",
    "ลงชื่อ กิ้ฟ วิท",
    "",
    "   ",
  ])("ignores %j", (text) => {
    expect(easterEggReply(text)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { askPromptPay, formatPromptPay } from "@/line/messages";
import { buttonActions, buttonLabels } from "./helpers";
import { editPatchSchema } from "@/services/game-admin.service";
import { gameDraftSchema, promptPaySchema } from "@/services/game.service";

const PENDING_ID = "6c2a2f16-9a7f-4f8e-9b4e-2d0f1a2b3c4d";

describe("promptPaySchema", () => {
  it.each([
    ["เบอร์มือถือธรรมดา", "0812345678", "0812345678"],
    ["เบอร์ที่มีขีดคั่น", "081-234-5678", "0812345678"],
    ["เบอร์ที่มีเว้นวรรค", " 081 234 5678 ", "0812345678"],
    ["เลขบัตรประชาชน", "1-2345-67890-12-3", "1234567890123"],
  ])("%s เก็บเป็นตัวเลขล้วน", (_label, input, expected) => {
    expect(promptPaySchema.parse(input)).toBe(expected);
  });

  it.each([
    ["สั้นเกินไป", "08123456"],
    ["ยาวเกินไป", "08123456789"],
    ["11 หลักไม่ใช่รูปแบบที่รับ", "12345678901"],
    ["ไม่มีตัวเลขเลย", "พร้อมเพย์ของผม"],
    ["ว่าง", ""],
  ])("ปฏิเสธ %s", (_label, input) => {
    expect(promptPaySchema.safeParse(input).success).toBe(false);
  });

  it("ข้อความยาวผิดปกติไม่ถูกเอาไปไล่ตัดตัวเลขทีละตัว", () => {
    expect(promptPaySchema.safeParse("0".repeat(100)).success).toBe(false);
  });
});

describe("ช่องพร้อมเพย์ใน schema ของรอบตี", () => {
  const draft = {
    court_count: 2,
    max_players: 16,
    play_date: "2030-01-15",
    start_time: "19:00",
    duration_minutes: 120,
    court_name: "ABC Badminton",
  };

  it("ตอนเปิดรอบ ไม่ใส่ก็ได้", () => {
    expect(gameDraftSchema.parse(draft).promptpay).toBeUndefined();
  });

  it("ตอนเปิดรอบ ใส่แบบมีขีดแล้วถูกทำให้เป็นตัวเลขล้วน", () => {
    expect(gameDraftSchema.parse({ ...draft, promptpay: "081-234-5678" }).promptpay).toBe(
      "0812345678",
    );
  });

  it("ตอนแก้ไขรอบ ก็ทำให้เป็นตัวเลขล้วนเหมือนกัน", () => {
    expect(editPatchSchema.parse({ promptpay: "081 234 5678" })).toEqual({
      promptpay: "0812345678",
    });
  });

  it("ตอนแก้ไขรอบ เลขผิดรูปแบบต้องไม่ผ่าน", () => {
    expect(editPatchSchema.safeParse({ promptpay: "1234" }).success).toBe(false);
  });
});

describe("formatPromptPay", () => {
  it("เบอร์มือถือแสดงเป็นสามท่อน", () => {
    expect(formatPromptPay("0812345678")).toBe("081-234-5678");
  });

  it("เลขบัตรประชาชนแสดงตามรูปแบบบนบัตร", () => {
    expect(formatPromptPay("1234567890123")).toBe("1-2345-67890-12-3");
  });
});

describe("คำถามเลขพร้อมเพย์", () => {
  it("กลุ่มที่ยังไม่เคยใส่ มีแค่ปุ่มข้าม", () => {
    expect(buttonLabels(askPromptPay(PENDING_ID, null))).toEqual(["ข้าม"]);
  });

  it("กลุ่มที่เคยใส่แล้ว มีปุ่มใช้เลขเดิมขึ้นก่อน", () => {
    const actions = buttonActions(askPromptPay(PENDING_ID, "0812345678"));
    expect(actions.map((action) => action.label)).toEqual(["ใช้ 081-234-5678", "ข้าม"]);
    expect(actions[0]?.data).toContain("step=promptpay&value=reuse");
  });
});

import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "@/errors/app-errors";
import { errorMessage } from "@/line/messages";
import { messageText } from "./helpers";

/**
 * code ที่ไม่มีข้อความของตัวเองจะตกไปเป็น "ระบบขัดข้อง" ผู้ใช้อ่านแล้วไม่รู้ว่าต้องทำอะไรต่อ
 * เคยหลุดมาแล้วจริงตอนพิมพ์คำสั่ง: BILL_AMBIGUOUS (มีหลายบิล) และ BILL_TITLE_TAKEN (ชื่อบิลซ้ำ)
 * วนจากรายชื่อ code จริง เพิ่ม code ใหม่แล้วลืมเขียนข้อความ เทสนี้จะแดงเอง
 */
describe("ทุก error code มีข้อความของตัวเอง", () => {
  const internal = messageText(errorMessage("INTERNAL_ERROR"));

  it.each(ERROR_CODES.filter((code) => code !== "INTERNAL_ERROR"))("%s", (code) => {
    expect(messageText(errorMessage(code))).not.toBe(internal);
  });
});

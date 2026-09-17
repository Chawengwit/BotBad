import { describe, expect, it } from "vitest";
import { askSameVenue, askWhen, DEFAULT_START_TIME } from "@/line/messages";
import { parsePostbackData } from "@/router/postback";

const PENDING_ID = "11111111-1111-4111-8111-111111111111";

function actionData(message: ReturnType<typeof askWhen>, label: string): string {
  const action = message.template.actions.find((item) => item.label === label);
  return action && "data" in action ? action.data : "";
}

/**
 * wizard เปิดรอบย่อจาก 8 ขั้นเหลือ 4 (spec §9.1)
 * ขั้นที่หายไปคือจำนวนคน (คิดจากคอร์ท), วันกับเวลาที่รวมเป็นขั้นเดียว
 * และชื่อคอร์ท/แผนที่/พร้อมเพย์ที่ยุบเป็นปุ่ม "ที่เดิม" ปุ่มเดียว
 */
describe("askWhen — ถามวันและเวลาพร้อมกัน", () => {
  it("ปุ่มลัดฝังทั้งวันและเวลามาในค่าเดียว", () => {
    const message = askWhen(PENDING_ID, "20:00", "2026-09-16");

    expect(parsePostbackData(actionData(message, "วันนี้ 20:00"))).toMatchObject({
      action: "wizard",
      pending_id: PENDING_ID,
      step: "when",
      value: "2026-09-16 20:00",
    });
    expect(parsePostbackData(actionData(message, "พรุ่งนี้ 20:00"))).toMatchObject({
      value: "2026-09-17 20:00",
    });
  });

  it("ใช้เวลาของรอบที่แล้วเป็นตัวตั้ง ไม่มีก็ใช้ค่าเริ่มต้น", () => {
    const usual = askWhen(PENDING_ID, "21:00", "2026-09-16");
    expect(usual.template.actions.map((action) => action.label)).toEqual([
      "วันนี้ 21:00",
      "พรุ่งนี้ 21:00",
      "เลือกวันและเวลา",
    ]);

    const first = askWhen(PENDING_ID, undefined, "2026-09-16");
    expect(first.template.actions[0]?.label).toBe(`วันนี้ ${DEFAULT_START_TIME}`);
  });

  it("ปฏิทินเลือกได้ทั้งวันและเวลา และห้ามย้อนหลัง", () => {
    const picker = askWhen(PENDING_ID, "19:00", "2026-09-16").template.actions.find(
      (action) => action.type === "datetimepicker",
    );

    expect(picker).toMatchObject({ mode: "datetime", initial: "2026-09-16T19:00", min: "2026-09-16T00:00" });
  });

  it("ถามครั้งเดียวพอ ไม่เกิน 4 ปุ่มตามที่ buttons template รับได้", () => {
    expect(askWhen(PENDING_ID).template.actions.length).toBeLessThanOrEqual(4);
  });
});

describe("askSameVenue — ยุบชื่อคอร์ท แผนที่ และพร้อมเพย์เป็นคำถามเดียว", () => {
  it("โชว์ของเดิมให้เห็นก่อนกด", () => {
    const message = askSameVenue(PENDING_ID, "ABC Badminton", true, "0812345678");

    expect(message.template.text).toContain("ABC Badminton");
    expect(message.template.text).toContain("มีลิงก์แผนที่");
    expect(message.template.text).toContain("081-234-5678");
  });

  it("ไม่มีแผนที่หรือพร้อมเพย์ก็ไม่ต้องขึ้นบรรทัดเปล่า", () => {
    const message = askSameVenue(PENDING_ID, "ABC Badminton", false, null);

    expect(message.template.text).not.toContain("แผนที่");
    expect(message.template.text).not.toContain("พร้อมเพย์");
  });

  it("มีสองทางเลือก: ที่เดิม หรือเปลี่ยนที่", () => {
    const message = askSameVenue(PENDING_ID, "ABC Badminton", true, null);

    expect(
      message.template.actions.map((action) =>
        parsePostbackData("data" in action ? action.data : "")?.["value" as never],
      ),
    ).toEqual(["same", "change"]);
  });

  it("ข้อความไม่เกิน 160 ตัวอักษรของ buttons template", () => {
    const message = askSameVenue(PENDING_ID, "x".repeat(60), true, "0812345678");
    expect(message.template.text.length).toBeLessThanOrEqual(160);
  });
});

describe("postback ของ wizard ที่ย่อแล้ว", () => {
  it.each([
    ["ปุ่มลัดวันเวลา", `action=wizard&pending_id=${PENDING_ID}&step=when&value=2026-09-16+19%3A00`],
    ["ปฏิทินวันเวลา", `action=wizard&pending_id=${PENDING_ID}&step=when&value=picker`],
    ["ที่เดิม", `action=wizard&pending_id=${PENDING_ID}&step=venue&value=same`],
    ["เปลี่ยนที่", `action=wizard&pending_id=${PENDING_ID}&step=venue&value=change`],
  ])("รับ %s", (_label, data) => {
    expect(parsePostbackData(data)).not.toBeNull();
  });

  it("ยังรับปุ่มวัน เวลา และจำนวนคนแยกกันได้ เพราะเมนูแก้ไขยังใช้อยู่", () => {
    for (const step of ["date", "time", "max"]) {
      expect(
        parsePostbackData(`action=wizard&pending_id=${PENDING_ID}&step=${step}&value=1`),
      ).not.toBeNull();
    }
  });
});

import { describe, expect, it } from "vitest";
import { parsePostbackData } from "@/router/postback";
import { askCourtCount, askDate, askDuration, askTime, confirmCreateGame } from "@/line/messages";
import { buttonData, messageText } from "./helpers";
import { missingDraftFields } from "@/services/game.service";

const PENDING_ID = "6c2a2f16-9a7f-4f8e-9b4e-2d0f1a2b3c4d";

describe("parsePostbackData", () => {
  it("อ่านข้อมูลของแต่ละขั้นใน wizard ได้", () => {
    expect(parsePostbackData(`action=wizard&pending_id=${PENDING_ID}&step=court&value=2`)).toEqual({
      action: "wizard",
      pending_id: PENDING_ID,
      step: "court",
      value: "2",
    });
  });

  it("อ่านปุ่มของคำถามเลขพร้อมเพย์ได้", () => {
    expect(
      parsePostbackData(`action=wizard&pending_id=${PENDING_ID}&step=promptpay&value=reuse`),
    ).toEqual({
      action: "wizard",
      pending_id: PENDING_ID,
      step: "promptpay",
      value: "reuse",
    });
  });

  it("อ่านปุ่มยืนยันและยกเลิกได้", () => {
    expect(parsePostbackData(`action=confirm&pending_id=${PENDING_ID}`)).toEqual({
      action: "confirm",
      pending_id: PENDING_ID,
    });
    expect(parsePostbackData(`action=reject&pending_id=${PENDING_ID}`)).toEqual({
      action: "reject",
      pending_id: PENDING_ID,
    });
  });

  it.each([
    ["ไม่มี action", `pending_id=${PENDING_ID}`],
    ["action ไม่รู้จัก", `action=drop_table&pending_id=${PENDING_ID}`],
    ["pending_id ไม่ใช่ uuid", "action=confirm&pending_id=123"],
    ["step ไม่รู้จัก", `action=wizard&pending_id=${PENDING_ID}&step=delete&value=1`],
    ["ไม่มี value", `action=wizard&pending_id=${PENDING_ID}&step=court`],
    ["ข้อความมั่ว", "??!!"],
    ["ว่าง", ""],
  ])("ปฏิเสธข้อมูลที่ %s", (_label, data) => {
    expect(parsePostbackData(data)).toBeNull();
  });
});

describe("ปุ่มที่บอทส่งออกไป", () => {
  it("ปุ่มจำนวนคอร์ทมี 4 ตัวเลือกและอ้าง pending เดียวกัน", () => {
    const message = askCourtCount(PENDING_ID);
    const actions = message.template.actions;

    expect(actions).toHaveLength(4);
    for (const action of actions) {
      const parsed = parsePostbackData((action as { data: string }).data);
      expect(parsed).toMatchObject({ action: "wizard", pending_id: PENDING_ID, step: "court" });
    }
  });

  it("ปุ่มเลือกวันมีตัวเลือกวันนี้ พรุ่งนี้ และปฏิทินที่ห้ามย้อนหลัง", () => {
    const actions = askDate(PENDING_ID, "2026-09-16").template.actions;
    const picker = actions.find((action) => action.type === "datetimepicker");

    expect(actions.map((action) => action.label)).toEqual(["วันนี้", "พรุ่งนี้", "เลือกวัน"]);
    expect(picker).toMatchObject({ mode: "date", min: "2026-09-16" });
  });

  it("ปุ่มเวลาและระยะเวลาส่งค่าที่ใช้ได้จริง", () => {
    const timeValues = askTime(PENDING_ID).template.actions.map(
      (action) => parsePostbackData((action as { data: string }).data)?.["value" as never],
    );
    expect(timeValues).toEqual(["18:00", "19:00", "20:00", "picker"]);

    const durationValues = askDuration(PENDING_ID).template.actions.map(
      (action) => parsePostbackData((action as { data: string }).data)?.["value" as never],
    );
    expect(durationValues).toEqual(["60", "120", "180"]);
  });

  it("การ์ดยืนยันสรุปรอบและมีปุ่มยืนยันกับยกเลิก", () => {
    const message = confirmCreateGame(PENDING_ID, {
      court_count: 1,
      max_players: 8,
      play_date: "2026-09-16",
      start_time: "19:00",
      duration_minutes: 120,
      court_name: "ABC Badminton",
    });

    const body = messageText(message);
    expect(body).toContain("ABC Badminton");
    expect(body).toContain("พุธ 16 ก.ย.");
    expect(body).toContain("19:00 - 21:00");
    expect(body).toContain("รับ 8 คน");

    // การ์ดยืนยันเป็น Flex แล้ว ปุ่มอยู่ที่ footer ไม่ติดเพดาน 160 ตัวอักษรอีก
    expect(parsePostbackData(buttonData([message], "เปิดตี") ?? "")?.action).toBe("confirm");
    expect(parsePostbackData(buttonData([message], "ยกเลิก") ?? "")?.action).toBe("reject");
  });
});

describe("missingDraftFields", () => {
  it("บอกช่องที่ขาดเรียงตามลำดับคำถาม", () => {
    expect(missingDraftFields({})).toEqual([
      "court_count",
      "play_date",
      "start_time",
      "duration_minutes",
      "court_name",
    ]);
    expect(missingDraftFields({ court_count: 2, play_date: "2026-09-16" })).toEqual([
      "start_time",
      "duration_minutes",
      "court_name",
    ]);
  });

  // จำนวนคนคิดจากคอร์ทให้เอง wizard จึงไม่ถาม และไม่นับว่า "ขาด"
  it("ไม่ถามจำนวนคน แต่ชื่อคอร์ทยังต้องมี", () => {
    expect(missingDraftFields({})).not.toContain("max_players");
    expect(missingDraftFields({ court_name: "   " })).toContain("court_name");
    expect(missingDraftFields({ court_name: "x".repeat(61) })).toContain("court_name");
  });

  it("ค่าที่ผิดรูปแบบถือว่ายังขาด", () => {
    expect(missingDraftFields({ court_count: 9 })).toContain("court_count");
    expect(missingDraftFields({ play_date: "16/09/2026" })).toContain("play_date");
    expect(missingDraftFields({ start_time: "25:00" })).toContain("start_time");
    expect(missingDraftFields({ duration_minutes: 45 })).toContain("duration_minutes");
  });

  it("ครบแล้วไม่เหลืออะไร", () => {
    expect(
      missingDraftFields({
        court_count: 1,
        max_players: 8,
        play_date: "2026-09-16",
        start_time: "19:00",
        duration_minutes: 120,
        court_name: "ABC Badminton",
      }),
    ).toEqual([]);
  });
});

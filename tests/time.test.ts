import { describe, expect, it } from "vitest";
import {
  addDays,
  endTime,
  formatDuration,
  formatThaiDate,
  formatTimeRange,
  isInThePast,
  timeNowInBangkok,
  todayInBangkok,
} from "@/lib/time";

// 2026-09-16 17:30 เวลาไทย = 10:30 UTC
const bangkokEvening = new Date("2026-09-16T10:30:00Z");

describe("เวลาไทย", () => {
  it("อ่านวันที่และเวลาตามโซนเวลาไทย ไม่ใช่ UTC", () => {
    expect(todayInBangkok(bangkokEvening)).toBe("2026-09-16");
    expect(timeNowInBangkok(bangkokEvening)).toBe("17:30");
  });

  it("ช่วงหัวค่ำ UTC ยังนับเป็นวันถัดไปของไทย", () => {
    // 2026-09-16 18:00 UTC = 2026-09-17 01:00 ที่ไทย
    const lateUtc = new Date("2026-09-16T18:00:00Z");
    expect(todayInBangkok(lateUtc)).toBe("2026-09-17");
    expect(timeNowInBangkok(lateUtc)).toBe("01:00");
  });
});

describe("addDays", () => {
  it.each([
    ["2026-09-16", 1, "2026-09-17"],
    ["2026-09-30", 1, "2026-10-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"], // ปีอธิกสุรทิน
  ])("%s + %i วัน = %s", (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });
});

describe("isInThePast", () => {
  it("วันเวลาที่ผ่านมาแล้วถือว่าอดีต", () => {
    expect(isInThePast("2026-09-16", "17:00", bangkokEvening)).toBe(true);
    expect(isInThePast("2026-09-15", "23:59", bangkokEvening)).toBe(true);
  });

  it("วันเวลาข้างหน้าไม่ใช่อดีต", () => {
    expect(isInThePast("2026-09-16", "18:00", bangkokEvening)).toBe(false);
    expect(isInThePast("2026-09-17", "06:00", bangkokEvening)).toBe(false);
  });
});

describe("endTime", () => {
  it.each([
    ["19:00", 120, "21:00"],
    ["19:30", 90, "21:00"],
    ["23:00", 120, "01:00"], // ข้ามเที่ยงคืน
  ])("%s + %i นาที = %s", (start, minutes, expected) => {
    expect(endTime(start, minutes)).toBe(expected);
  });
});

describe("รูปแบบข้อความ", () => {
  it("แสดงวันที่เป็นภาษาไทย", () => {
    expect(formatThaiDate("2026-09-16")).toBe("พุธ 16 ก.ย.");
    expect(formatThaiDate("2026-01-01")).toBe("พฤหัส 1 ม.ค.");
  });

  it("แสดงช่วงเวลาและระยะเวลา", () => {
    expect(formatTimeRange("19:00", 120)).toBe("19:00 - 21:00");
    expect(formatDuration(120)).toBe("2 ชั่วโมง");
  });
});

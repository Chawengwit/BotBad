import { describe, expect, it } from "vitest";
import { FRIDAY, isFridayInBangkok, weekdayOf } from "@/lib/time";
import { buildDigest, summarizeGroup } from "@/services/digest.service";
import type { GroupDigestData } from "@/repositories/digest.repository";
import type { GameRow } from "@/repositories/types";
import { hasButtons, messageText } from "./helpers";

const game: GameRow = {
  id: "1",
  line_group_id: "C123",
  created_by: "1",
  play_date: "2026-09-22",
  start_time: "19:00",
  duration_minutes: 120,
  court_count: 2,
  max_players: 16,
  status: "open",
  court_name: "ABC Badminton",
  location_url: null,
  promptpay: null,
  edit_count: 0,
};

const empty: GroupDigestData = {
  lineGroupId: "C123",
  games: [],
  unpaidBillCount: 0,
  unpaidTotalSatang: 0,
};

/** สรุปยิงสัปดาห์ละครั้ง วันอื่นต้องไม่ push (PRP §6.1) */
describe("วันศุกร์ตามเวลาไทย", () => {
  it.each([
    ["2026-09-18", true],
    ["2026-09-17", false],
    ["2026-09-19", false],
  ])("%s → ศุกร์ไหม %s", (date, expected) => {
    expect(weekdayOf(date) === FRIDAY).toBe(expected);
  });

  it("คิดจากวันที่ของไทย ไม่ใช่ของ UTC", () => {
    // 2026-09-18T17:30Z = 2026-09-19 00:30 ที่ไทย ซึ่งเป็นวันเสาร์แล้ว
    expect(isFridayInBangkok(new Date("2026-09-18T17:30:00Z"))).toBe(false);
    // 2026-09-17T17:30Z = 2026-09-18 00:30 ที่ไทย ซึ่งเป็นวันศุกร์
    expect(isFridayInBangkok(new Date("2026-09-17T17:30:00Z"))).toBe(true);
  });
});

describe("ไม่มีเรื่องจะบอก = ไม่ส่ง", () => {
  it("ไม่มีรอบ ไม่มีบิลค้าง", () => {
    expect(summarizeGroup(empty)).toBeNull();
    expect(buildDigest(empty)).toBeNull();
  });

  it("บิลจ่ายครบแล้วไม่นับว่ามีเรื่อง", () => {
    const settled = { ...empty, unpaidBillCount: 0, unpaidTotalSatang: 0 };
    expect(buildDigest(settled)).toBeNull();
  });
});

describe("เนื้อหาของสรุป", () => {
  it("มีรอบที่เปิดอยู่ บอกวันเวลาและจำนวนคน ไม่ว่าจะตีวันไหน", () => {
    const body = messageText(buildDigest({ ...empty, games: [{ game, joinedCount: 6 }] })![0]!);

    expect(body).toContain("มีนัด");
    expect(body).toContain("อังคาร 22 ก.ย.");
    expect(body).toContain("19:00 - 21:00");
    expect(body).toContain("ABC Badminton");
    expect(body).toContain("6/16 คน");
  });

  // กลุ่มเปิดได้หลายรอบ บอกทุกรอบในการ์ดใบเดียว (PRP multi-open-rounds §3.1)
  it("เปิดหลายรอบ บอกทุกรอบพร้อมจำนวนคนของแต่ละรอบ", () => {
    const saturday = { ...game, id: "2", play_date: "2026-09-26", court_name: "คอร์ทสามย่าน" };
    const body = messageText(
      buildDigest({ ...empty, games: [{ game, joinedCount: 6 }, { game: saturday, joinedCount: 3 }] })![0]!,
    );

    expect(body).toContain("ABC Badminton");
    expect(body).toContain("6/16 คน");
    expect(body).toContain("เสาร์ 26 ก.ย.");
    expect(body).toContain("คอร์ทสามย่าน");
    expect(body).toContain("3/16 คน");
  });

  it("บิลค้างบอกจำนวนใบและยอดรวม", () => {
    const body = messageText(
      buildDigest({ ...empty, unpaidBillCount: 2, unpaidTotalSatang: 50700 })![0]!,
    );

    expect(body).toContain("บิลค้างจ่าย");
    expect(body).toContain("2 ใบ");
    expect(body).toContain("507.00");
  });

  it("มีทั้งรอบและบิลก็รวมอยู่ในข้อความเดียว ไม่ push สองครั้ง", () => {
    const messages = buildDigest({
      ...empty,
      games: [{ game, joinedCount: 6 }],
      unpaidBillCount: 1,
      unpaidTotalSatang: 9500,
    })!;

    expect(messages).toHaveLength(1);
    expect(messageText(messages[0]!)).toContain("มีนัด");
    expect(messageText(messages[0]!)).toContain("บิลค้างจ่าย");
  });

  it("ไม่มีปุ่ม เพราะเป็นผลลัพธ์ ไม่ใช่คำถาม (spec §23)", () => {
    expect(hasButtons(buildDigest({ ...empty, games: [{ game, joinedCount: 6 }] })![0]!)).toBe(false);
  });
});

/**
 * ข้อบังคับจากเจ้าของโปรเจค: สรุปห้ามประจานคนค้างจ่าย
 * บอกได้แค่ว่ามีกี่ใบ ใครอยากรู้ชื่อให้พิมพ์ถามเอง (PRP §6.2)
 */
describe("ห้ามมีชื่อคนค้างจ่ายหลุดออกมา", () => {
  it("ข้อความมีแต่ตัวเลข ไม่มีรายชื่อ", () => {
    const body = messageText(
      buildDigest({
        ...empty,
        games: [{ game, joinedCount: 6 }],
        unpaidBillCount: 1,
        unpaidTotalSatang: 50700,
      })![0]!,
    );

    for (const name of ["เชวง", "Bank", "ฮก", "กิ้ฟ"]) {
      expect(body).not.toContain(name);
    }
    expect(body).toContain("ใครยังไม่จ่าย");
  });
});

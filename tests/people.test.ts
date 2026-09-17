import { describe, expect, it } from "vitest";
import {
  isSelfWord,
  MAX_NAMES_PER_COMMAND,
  MAX_NAME_LENGTH,
  parseNames,
} from "@/services/people.service";
import { parseCommand, RULE_COMMANDS } from "@/router/rule-commands";
import { joinedForNotice, leftForNotice } from "@/line/messages";
import { hasButtons, messageText } from "./helpers";

describe("parseNames", () => {
  it.each([
    ["กิ้ฟ วิท", ["กิ้ฟ", "วิท"]],
    ["กิ้ฟ, วิท", ["กิ้ฟ", "วิท"]],
    ["  กิ้ฟ   วิท  ", ["กิ้ฟ", "วิท"]],
    ["กิ้ฟ", ["กิ้ฟ"]],
    ["", []],
    ["   ", []],
  ])("%s → %j", (input, expected) => {
    expect(parseNames(input)).toEqual(expected);
  });

  it("ตัดชื่อที่ยาวผิดปกติทิ้ง ไม่ให้กลายเป็นแขกชื่อประหลาด", () => {
    expect(parseNames("ก".repeat(MAX_NAME_LENGTH + 1))).toEqual([]);
  });

  it("จำกัดจำนวนชื่อต่อคำสั่ง กันลงชื่อรัวจนรอบเต็ม", () => {
    const many = Array.from({ length: MAX_NAMES_PER_COMMAND + 5 }, (_, i) => `คน${i}`).join(" ");
    expect(parseNames(many)).toHaveLength(MAX_NAMES_PER_COMMAND);
  });

  it.each(["ฉัน", "ผม", "เรา", "me", "ME"])("%s แปลว่าตัวเอง", (word) => {
    expect(isSelfWord(word)).toBe(true);
  });

  it("ชื่อคนทั่วไปไม่ใช่คำเรียกตัวเอง", () => {
    expect(isSelfWord("กิ้ฟ")).toBe(false);
  });
});

/** spec §18 เดิมเทียบแบบตรงทั้งข้อความ ตอนนี้บางคำสั่งรับส่วนเติมท้ายได้ (PRP §8.1) */
describe("parseCommand", () => {
  it("คำสั่งเปล่ายังทำงานเหมือนเดิมทุกคำสั่ง", () => {
    for (const command of RULE_COMMANDS) {
      expect(parseCommand(command)).toEqual({ command, args: "" });
    }
  });

  it.each([
    ["ลงชื่อ กิ้ฟ วิท", "ลงชื่อ", "กิ้ฟ วิท"],
    ["ถอนชื่อ กิ้ฟ", "ถอนชื่อ", "กิ้ฟ"],
    ["จ่ายแล้ว กิ้ฟ วิท", "จ่ายแล้ว", "กิ้ฟ วิท"],
    ["ยังไม่จ่าย กิ้ฟ", "ยังไม่จ่าย", "กิ้ฟ"],
  ])("%s แยกเป็นคำสั่งกับรายชื่อ", (input, command, args) => {
    expect(parseCommand(input)).toEqual({ command, args });
  });

  it("ต้องมีตัวคั่นจริง ไม่ใช่คำที่บังเอิญขึ้นต้นเหมือนกัน", () => {
    expect(parseCommand("ลงชื่อกิ้ฟ")).toBeNull();
  });

  it("คำสั่งที่ไม่รับส่วนเติมท้าย ใส่มาก็ไม่ผ่าน ต้องตกไปให้ LLM", () => {
    expect(parseCommand("เปิดตี พรุ่งนี้")).toBeNull();
    expect(parseCommand("ใครตีบ้าง วันนี้")).toBeNull();
  });

  it("ข้อความที่ไม่ใช่คำสั่งเลย คืน null", () => {
    expect(parseCommand("คืนนี้ใครไปบ้าง")).toBeNull();
  });
});

const guest = (name: string) => ({ display_name: name });

describe("ข้อความตอนลงชื่อแทนกัน", () => {
  it("บอกชัดว่าใครลงให้ใคร ไม่ใช่ขึ้นแค่ชื่อคนถูกลง (PRP §4.7)", () => {
    const body = messageText(
      joinedForNotice("ฮก", { joinedCount: 7, people: [guest("กิ้ฟ"), guest("วิท")], skipped: [] }, [
        "กิ้ฟ",
        "วิท",
      ]),
    );

    expect(body).toContain("ฮก ลงชื่อให้ กิ้ฟ, วิท");
    expect(body).toContain("เพิ่มแขกใหม่");
    expect(body).toContain("7 คน");
  });

  it("คนที่ลงไว้อยู่แล้วบอกให้รู้ ไม่ใช่เงียบหาย", () => {
    const body = messageText(
      joinedForNotice("ฮก", {
        joinedCount: 6,
        people: [guest("กิ้ฟ")],
        skipped: [{ user: guest("วิท"), reason: "already_joined" }],
      }),
    );

    expect(body).toContain("กิ้ฟ");
    expect(body).toContain("วิท ลงชื่อไว้อยู่แล้ว");
  });

  it("ถอนคนที่ไม่ใช่แขกของเราไม่ได้ และต้องบอกเหตุผล", () => {
    const body = messageText(
      leftForNotice("ฮก", {
        joinedCount: 8,
        people: [],
        skipped: [{ user: guest("เชวง"), reason: "not_yours" }],
      }),
    );

    expect(body).toContain("ถอนได้เฉพาะเจ้าตัวกับคนที่ลงชื่อให้");
    expect(body).toContain("เชวง");
  });

  it("ชื่อที่ไม่รู้จักตอนถอน บอกว่าไม่รู้จัก ไม่เงียบ", () => {
    const body = messageText(
      leftForNotice("ฮก", { joinedCount: 8, people: [], skipped: [] }, ["สมชาย"]),
    );
    expect(body).toContain("ไม่รู้จัก สมชาย");
  });

  it("ไม่มีปุ่มติดมา เพราะเป็นผลลัพธ์ (spec §23)", () => {
    expect(
      hasButtons(joinedForNotice("ฮก", { joinedCount: 7, people: [guest("กิ้ฟ")], skipped: [] })),
    ).toBe(false);
  });
});

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LineMessage } from "@/lib/line";
import { icon, ICON_COLORS, ICON_NAMES, type IconColor } from "@/line/flex";
import {
  buttonActions,
  buttonLabels,
  hasButtons,
  iconUrls,
  makeBill,
  makeItem,
  makeShare,
  messageText,
} from "./helpers";
import {
  askCourtCount,
  askCourtFee,
  askDate,
  askDuration,
  askExtraItem,
  askLocation,
  askMaxPlayers,
  askPromptPay,
  askSameVenue,
  askShuttleCount,
  askShuttlePrice,
  askTime,
  askWhen,
  billCard,
  confirmBill,
  confirmCancelBill,
  confirmCancelGame,
  confirmCloseGame,
  confirmCreateGame,
  confirmEditGame,
  editMenu,
  fallbackMenu,
  gameCancelled,
  gameCard,
  gameClosed,
  greeting,
  helpMenu,
  joinedNotice,
  leftNotice,
  paymentRecorded,
  paymentUndone,
  playerList,
  unpaidList,
} from "@/line/messages";
import type { BillRow, BillShareRow, GameRow } from "@/repositories/types";

const PENDING_ID = "11111111-1111-4111-8111-111111111111";

const game: GameRow = {
  id: "1",
  line_group_id: "C123",
  created_by: "1",
  play_date: "2026-09-16",
  start_time: "19:00",
  duration_minutes: 120,
  court_count: 1,
  max_players: 8,
  status: "open",
  court_name: "ABC Badminton",
  location_url: "https://maps.example.com/abc",
  promptpay: "0812345678",
  edit_count: 0,
};

const bill: BillRow = makeBill({ total_satang: 60000 });

const items = [
  makeItem(0, "ค่าคอร์ท", 60000, [
    { user_id: "1", display_name: "เชวง", amount_satang: 30000 },
    { user_id: "2", display_name: "Bank", amount_satang: 30000 },
  ]),
];

const shares: BillShareRow[] = [
  makeShare("1", "เชวง", true, 30000),
  makeShare("2", "Bank", false, 30000),
];

const draft = {
  court_count: 1,
  max_players: 8,
  play_date: "2026-09-16",
  start_time: "19:00",
  duration_minutes: 120,
  court_name: "ABC Badminton",
};

/**
 * บอทแนบปุ่มได้ 3 กรณีเท่านั้น (spec §23)
 *   1. กำลังถามเพื่อเดิน wizard ต่อ
 *   2. ขอให้กดยืนยัน
 *   3. ทักทาย / fallback ที่บอทรอคำสั่งอยู่
 * ผลลัพธ์ของ action ต้องเป็นข้อความล้วนเสมอ ไม่งั้นบอทจะพ่นปุ่มใส่กลุ่มทุกครั้งที่มีคนขยับ
 */
describe("ข้อความผลลัพธ์ต้องไม่มีปุ่ม", () => {
  it.each([
    ["ลงชื่อสำเร็จ", joinedNotice("เชวง", 5, 8)],
    ["ถอนชื่อสำเร็จ", leftNotice("เชวง", 4, 8)],
    ["การ์ดรอบตี", gameCard(game, 5, { icon: "table-tennis-paddle-ball", text: "เปิดรอบตีแล้ว" })],
    ["รายชื่อผู้เล่น", playerList(game, [{ display_name: "เชวง" }])],
    ["การ์ดบิล", billCard(bill, items, shares, { icon: "receipt", text: "คิดเงินแล้ว" })],
    ["รายชื่อคนค้างจ่าย", unpaidList(bill, shares)],
    ["บันทึกว่าจ่ายแล้ว", paymentRecorded("เชวง", { shares, people: [{ user: { display_name: "เชวง" }, amountSatang: 30000 }], refused: [] })],
    ["ย้อนกลับเป็นยังไม่จ่าย", paymentUndone("เชวง", { shares, people: [{ user: { display_name: "เชวง" }, amountSatang: 30000 }], refused: [] })],
    ["ยกเลิกรอบแล้ว", gameCancelled()],
    ["ปิดรอบแล้ว", gameClosed()],
    ["ปิดรอบแล้วแต่ยังมีคนค้าง", gameClosed([shares[1]!])],
  ])("%s", (_label, message) => {
    expect(hasButtons(message)).toBe(false);
  });

  it("ขอรายชื่อแล้วได้รายชื่ออย่างเดียว ไม่แถการ์ดรอบตีตามมา", () => {
    const body = messageText(playerList(game, [{ display_name: "เชวง" }]));
    expect(body).toContain("เชวง");
    expect(body).not.toContain("ทำอะไรต่อดี");
  });
});

/** ป้ายปุ่มเป็นข้อความล้วน อีโมจิอยู่ได้เฉพาะในเนื้อการ์ด */
const EMOJI = /\p{Extended_Pictographic}/u;

describe("ป้ายปุ่มต้องไม่มีอีโมจิ", () => {
  it.each([
    ["ถามจำนวนคอร์ท", askCourtCount(PENDING_ID)],
    ["ถามวันและเวลา", askWhen(PENDING_ID)],
    ["ถามจำนวนคน", askMaxPlayers(PENDING_ID, 1)],
    ["ถามที่เดิม", askSameVenue(PENDING_ID, "ABC Badminton", true, "0812345678")],
    ["ถามลิงก์แผนที่", askLocation(PENDING_ID)],
    ["ถามเลขพร้อมเพย์", askPromptPay(PENDING_ID, "0812345678")],
    ["เมนูแก้ไข", editMenu(PENDING_ID)],
    ["ถามค่าคอร์ท", askCourtFee(PENDING_ID)],
    ["ถามค่าอื่น ๆ", askExtraItem(PENDING_ID)],
    ["ยืนยันเปิดรอบ", confirmCreateGame(PENDING_ID, draft)],
    ["ยืนยันยกเลิกรอบ", confirmCancelGame(PENDING_ID, game, 5)],
    ["ยืนยันปิดรอบ", confirmCloseGame(PENDING_ID, game, 5)],
  ])("%s", (_label, message) => {
    const labels = buttonLabels(message);
    expect(labels.length).toBeGreaterThan(0);

    for (const label of labels) {
      expect(label, label).not.toMatch(EMOJI);
    }
  });
});

describe("ข้อความที่ถามหรือขอยืนยันต้องยังมีปุ่ม", () => {
  it.each([
    ["ถามจำนวนคอร์ท", askCourtCount(PENDING_ID)],
    ["ถามจำนวนคน", askMaxPlayers(PENDING_ID, 1)],
    ["ถามลิงก์แผนที่", askLocation(PENDING_ID)],
    ["ถามเลขพร้อมเพย์", askPromptPay(PENDING_ID, null)],
    ["เมนูแก้ไข", editMenu(PENDING_ID)],
    ["ถามค่าคอร์ท", askCourtFee(PENDING_ID)],
    ["ถามจำนวนลูกแบด", askShuttleCount(PENDING_ID)],
    ["ถามค่าอื่น ๆ", askExtraItem(PENDING_ID)],
    ["ยืนยันเปิดรอบ", confirmCreateGame(PENDING_ID, draft)],
    ["ยืนยันยกเลิกรอบ", confirmCancelGame(PENDING_ID, game, 5)],
    ["ยืนยันปิดรอบ", confirmCloseGame(PENDING_ID, game, 5)],
    ["ทักทายตอนเรียกชื่อเปล่า ๆ", greeting()],
    ["เมนูสำรองตอนตีความไม่ออก", fallbackMenu()],
  ])("%s", (_label, message) => {
    expect(hasButtons(message)).toBe(true);
  });
});

/** ทุกข้อความที่มีปุ่มให้กด */
const BUTTON_MESSAGES: [string, LineMessage][] = [
  ["ถามจำนวนคอร์ท", askCourtCount(PENDING_ID)],
  ["ถามวันและเวลา", askWhen(PENDING_ID)],
  ["ถามวัน", askDate(PENDING_ID)],
  ["ถามเวลา", askTime(PENDING_ID)],
  ["ถามกี่ชั่วโมง", askDuration(PENDING_ID)],
  ["ถามจำนวนคน", askMaxPlayers(PENDING_ID, 4)],
  ["ถามที่เดิม", askSameVenue(PENDING_ID, "ABC Badminton", true, "0812345678")],
  ["ถามลิงก์แผนที่", askLocation(PENDING_ID)],
  ["ถามเลขพร้อมเพย์ (เลขบัตรประชาชน)", askPromptPay(PENDING_ID, "1234567890123")],
  ["เมนูแก้ไข", editMenu(PENDING_ID)],
  ["ถามค่าคอร์ท", askCourtFee(PENDING_ID)],
  ["ถามจำนวนลูกแบด", askShuttleCount(PENDING_ID)],
  ["ถามราคาลูกแบด", askShuttlePrice(PENDING_ID, 9500)],
  ["ถามค่าอื่น ๆ", askExtraItem(PENDING_ID)],
  ["ยืนยันเปิดรอบ", confirmCreateGame(PENDING_ID, draft)],
  ["ยืนยันแก้ไข", confirmEditGame(PENDING_ID, game, { court_count: 2 })],
  ["ยืนยันยกเลิกรอบ", confirmCancelGame(PENDING_ID, game, 5)],
  ["ยืนยันปิดรอบ", confirmCloseGame(PENDING_ID, game, 5)],
  ["ยืนยันส่งบิล", confirmBill(PENDING_ID, bill.title, items, bill.total_satang, shares)],
  ["ยืนยันยกเลิกบิล", confirmCancelBill(PENDING_ID, bill, shares)],
  ["ทักทาย", greeting()],
  ["เมนูช่วยเหลือ", helpMenu()],
  ["เมนูสำรองตอนตีความไม่ออก", fallbackMenu()],
];

/**
 * ปุ่มทุกปุ่มอยู่ท้ายการ์ด Flex
 * Quick Reply ไม่ขึ้นบน LINE PC และหายทันทีที่ใครก็ได้ในกลุ่มกด ทำให้เจ้าของเสียปุ่มไปทั้งชุด
 */
describe("ปุ่มที่รอให้กดต้องอยู่ท้ายการ์ด Flex", () => {
  /** ป้าย action บน Flex ยาวได้ไม่เกิน 40 ตัวอักษร */
  const MAX_LABEL = 40;

  it.each(BUTTON_MESSAGES)("%s", (_label, message) => {
    expect(message.type).toBe("flex");
    expect(message).not.toHaveProperty("quickReply");

    const footer = message.type === "flex" ? message.contents.footer : undefined;
    const footerLabels = buttonLabels({ type: "flex", contents: { footer } });
    expect(footerLabels.length).toBeGreaterThan(0);
    // ปุ่มทั้งหมดต้องอยู่ที่ footer ไม่กระจายไปอยู่ในตัวการ์ด
    expect(buttonLabels(message)).toEqual(footerLabels);

    for (const action of buttonActions(message)) {
      expect(action.label?.length ?? 0, action.label).toBeLessThanOrEqual(MAX_LABEL);
      // displayText ทำให้ LINE โพสต์ข้อความในนามคนกด คนกดผิดคนจะทิ้งข้อความลอย ๆ ไว้ในกลุ่ม
      expect(action, action.label).not.toHaveProperty("displayText");
    }
  });
});

/** อีโมจิหน้าตาต่างกันไปตามเครื่อง การ์ดใช้ไอคอน Font Awesome แทนทั้งหมด */
describe("การ์ด Flex ไม่มีอีโมจิ", () => {
  it.each([
    ...BUTTON_MESSAGES,
    ["การ์ดรอบตี", gameCard(game, 5, { icon: "table-tennis-paddle-ball", text: "เปิดรอบตีแล้ว" })],
    ["รายชื่อผู้เล่น", playerList(game, [{ display_name: "เชวง" }])],
    ["การ์ดบิล", billCard(bill, items, shares, { icon: "receipt", text: "คิดเงินแล้ว" })],
    ["รายชื่อคนค้างจ่าย", unpaidList(bill, shares)],
    ["ยืนยันปิดรอบ ทั้งที่ยังมีคนค้าง", confirmCloseGame(PENDING_ID, game, 5, [shares[1]!])],
    ["ยืนยันแก้ไขทุกช่อง", confirmEditGame(PENDING_ID, game, {
      court_count: 2,
      max_players: 16,
      court_name: "XYZ",
      location_url: "https://maps.example.com/xyz",
      promptpay: "0899999999",
      play_date: "2026-09-17",
      start_time: "20:00",
      duration_minutes: 180,
    })],
  ] as [string, LineMessage][])("%s", (_label, message) => {
    expect(message.type).toBe("flex");
    expect(messageText(message)).not.toMatch(EMOJI);
  });
});

/** LINE โหลดไอคอนจาก URL จริง ถ้าไฟล์ไม่มี ไอคอนจะหายไปเฉย ๆ โดยไม่มี error */
describe("ไอคอนทุกตัวที่การ์ดอ้างถึงมีไฟล์อยู่จริง", () => {
  it.each(BUTTON_MESSAGES)("%s", (_label, message) => {
    const urls = iconUrls(message);
    expect(urls.length).toBeGreaterThan(0);

    for (const url of urls) {
      expect(url).toMatch(/^https:\/\/[^/]+\/icons\/[0-9a-f]{6}\/[a-z0-9-]+\.png$/);
      const file = join(process.cwd(), "public", new URL(url).pathname);
      expect(existsSync(file), file).toBe(true);
    }
  });
});

/** เปลี่ยนค่าสีใน COLOR แล้วลืมสร้างไฟล์ชุดใหม่ ไอคอนสีนั้นจะหายไปจากทุกการ์ด */
describe("มีไฟล์ไอคอนครบทุกชื่อทุกสี", () => {
  it.each(Object.keys(ICON_COLORS) as IconColor[])("%s", (color) => {
    for (const name of ICON_NAMES) {
      const file = join(process.cwd(), "public", new URL(icon(name, color).url).pathname);
      expect(existsSync(file), file).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { LineMessage } from "@/lib/line";
import {
  askCourtCount,
  askCourtFee,
  askExtraItem,
  askLocation,
  askMaxPlayers,
  askPromptPay,
  askShuttleCount,
  billCard,
  confirmCancelGame,
  confirmCloseGame,
  confirmCreateGame,
  editMenu,
  fallbackMenu,
  gameCancelled,
  gameCard,
  gameClosed,
  greeting,
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

const bill: BillRow = {
  id: "1",
  game_id: "1",
  created_by: "1",
  status: "sent",
  items: [{ label: "ค่าคอร์ท", quantity: 1, unit_price_satang: 60000, amount_satang: 60000 }],
  total_satang: 60000,
};

const shares: BillShareRow[] = [
  { id: "1", bill_id: "1", user_id: "1", amount_satang: 30000, paid: true, display_name: "เชวง" },
  { id: "2", bill_id: "1", user_id: "2", amount_satang: 30000, paid: false, display_name: "Bank" },
];

/** ปุ่มของ LINE มาได้ 2 ทาง: ใน buttons template หรือใน quick reply */
function hasButtons(message: LineMessage): boolean {
  return message.type === "template" || message.quickReply !== undefined;
}

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
    ["การ์ดรอบตี", gameCard(game, 5, "🏸 เปิดรอบตีแล้ว")],
    ["รายชื่อผู้เล่น", playerList(game, [{ display_name: "เชวง" }])],
    ["การ์ดบิล", billCard(game, bill, shares, "💰 คิดเงินแล้ว")],
    ["รายชื่อคนค้างจ่าย", unpaidList(game, bill, shares)],
    ["บันทึกว่าจ่ายแล้ว", paymentRecorded("เชวง", 30000, shares)],
    ["ย้อนกลับเป็นยังไม่จ่าย", paymentUndone("เชวง", shares)],
    ["ยกเลิกรอบแล้ว", gameCancelled()],
    ["ปิดรอบแล้ว", gameClosed()],
    ["ปิดรอบแล้วแต่ยังมีคนค้าง", gameClosed([shares[1]!])],
  ])("%s", (_label, message) => {
    expect(hasButtons(message)).toBe(false);
  });

  it("ขอรายชื่อแล้วได้รายชื่ออย่างเดียว ไม่แถการ์ดรอบตีตามมา", () => {
    const message = playerList(game, [{ display_name: "เชวง" }]);
    expect(message.text).toContain("เชวง");
    expect(message.text).not.toContain("ทำอะไรต่อดี");
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
    [
      "ยืนยันเปิดรอบ",
      confirmCreateGame(PENDING_ID, {
        court_count: 1,
        max_players: 8,
        play_date: "2026-09-16",
        start_time: "19:00",
        duration_minutes: 120,
        court_name: "ABC Badminton",
      }),
    ],
    ["ยืนยันยกเลิกรอบ", confirmCancelGame(PENDING_ID, game, 5)],
    ["ยืนยันปิดรอบ", confirmCloseGame(PENDING_ID, game, 5)],
    ["ทักทายตอนเรียกชื่อเปล่า ๆ", greeting()],
    ["เมนูสำรองตอนตีความไม่ออก", fallbackMenu()],
  ])("%s", (_label, message) => {
    expect(hasButtons(message)).toBe(true);
  });
});

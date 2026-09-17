import { describe, expect, it } from "vitest";
import type { FlexBox, FlexComponent, FlexMessage, LineMessage } from "@/lib/line";
import {
  billCard,
  confirmBill,
  confirmCancelBill,
  confirmCancelGame,
  confirmCloseGame,
  confirmCreateGame,
  confirmEditGame,
  gameCard,
  playerList,
  unpaidList,
} from "@/line/messages";
import type { BillRow, BillShareRow, GameRow } from "@/repositories/types";

const PENDING_ID = "11111111-1111-4111-8111-111111111111";
/** altText ของ LINE ยาวได้ไม่เกิน 400 ตัวอักษร */
const MAX_ALT_TEXT = 400;

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

const bareGame: GameRow = { ...game, court_name: null, location_url: null, promptpay: null };

const items = [
  { label: "ค่าคอร์ท", quantity: 1, unit_price_satang: 60000, amount_satang: 60000 },
  { label: "ลูกแบด", quantity: 4, unit_price_satang: 2500, amount_satang: 10000 },
];

const bill: BillRow = {
  id: "1",
  game_id: "1",
  created_by: "1",
  status: "sent",
  items,
  total_satang: 70000,
};

const share = (id: string, name: string, paid: boolean): BillShareRow => ({
  id,
  bill_id: "1",
  user_id: id,
  amount_satang: 35000,
  paid,
  display_name: name,
});

const mixedShares = [share("1", "เชวง", true), share("2", "Bank", false)];
const allPaid = [share("1", "เชวง", true), share("2", "Bank", true)];

const draft = {
  court_count: 1,
  max_players: 8,
  play_date: "2026-09-16",
  start_time: "19:00",
  duration_minutes: 120,
  court_name: "ABC Badminton",
};

/** ทุกการ์ด Flex ที่บอทส่งออกไปได้จริง รวมเคสที่ข้อมูลไม่ครบด้วย */
const CARDS: [string, LineMessage][] = [
  ["การ์ดรอบตี", gameCard(game, 5, "🏸 เปิดรอบตีแล้ว")],
  ["การ์ดรอบตี ไม่มีหัวข้อและไม่มีแผนที่", gameCard(bareGame, 0)],
  ["รายชื่อผู้เล่น", playerList(game, [{ display_name: "เชวง" }, { display_name: "Bank" }])],
  ["รายชื่อตอนยังไม่มีใครลง", playerList(bareGame, [])],
  ["ยืนยันเปิดรอบ", confirmCreateGame(PENDING_ID, draft)],
  ["ยืนยันเปิดรอบ พร้อมแผนที่และพร้อมเพย์", confirmCreateGame(PENDING_ID, { ...draft, location_url: "https://maps.example.com/abc", promptpay: "0812345678" })],
  ["ยืนยันแก้ไข", confirmEditGame(PENDING_ID, game, { court_count: 2, max_players: 16 })],
  ["ยืนยันยกเลิกรอบ", confirmCancelGame(PENDING_ID, game, 5)],
  ["ยืนยันปิดรอบ", confirmCloseGame(PENDING_ID, game, 8)],
  ["ยืนยันปิดรอบ ทั้งที่ยังมีคนค้าง", confirmCloseGame(PENDING_ID, game, 8, [mixedShares[1]!])],
  ["ยืนยันส่งบิล", confirmBill(PENDING_ID, game, items, 70000, 2)],
  ["การ์ดบิล", billCard(game, bill, mixedShares, "💰 คิดเงินแล้ว")],
  ["การ์ดบิล ไม่มีพร้อมเพย์และจ่ายครบแล้ว", billCard(bareGame, bill, allPaid)],
  ["ใครยังไม่จ่าย", unpaidList(game, bill, mixedShares)],
  ["ใครยังไม่จ่าย ตอนจ่ายครบแล้ว", unpaidList(bareGame, bill, allPaid)],
  ["ยืนยันยกเลิกบิล", confirmCancelBill(PENDING_ID, game, mixedShares)],
  ["ยืนยันยกเลิกบิล ตอนยังไม่มีใครจ่าย", confirmCancelBill(PENDING_ID, game, [share("2", "Bank", false)])],
];

function isFlex(message: LineMessage): message is FlexMessage {
  return message.type === "flex";
}

/** เดินทุก component ในการ์ด เพื่อตรวจทีละชิ้น */
function walk(component: FlexComponent, visit: (node: FlexComponent) => void): void {
  visit(component);
  if (component.type === "box") {
    for (const child of component.contents) walk(child, visit);
  }
}

function boxes(message: FlexMessage): FlexBox[] {
  const found: FlexComponent[] = [];
  for (const section of [message.contents.header, message.contents.body, message.contents.footer]) {
    if (section) walk(section, (node) => found.push(node));
  }
  return found.filter((node): node is FlexBox => node.type === "box");
}

function components(message: FlexMessage): FlexComponent[] {
  const found: FlexComponent[] = [];
  for (const section of [message.contents.header, message.contents.body, message.contents.footer]) {
    if (section) walk(section, (node) => found.push(node));
  }
  return found;
}

/**
 * Flex ที่โครงผิด LINE จะตอบ 400 แล้วข้อความหายไปเงียบ ๆ ไม่มีใครรู้ (spec §23)
 * เทสชุดนี้จึงตรวจกติกาที่พังง่ายที่สุดกับการ์ดทุกใบ รวมเคสข้อมูลไม่ครบ
 */
describe("โครงสร้าง Flex ถูกกติกาของ LINE", () => {
  it.each(CARDS)("%s", (_label, message) => {
    expect(isFlex(message)).toBe(true);
    if (!isFlex(message)) return;

    expect(message.contents.type).toBe("bubble");

    // bubble ต้องมีเนื้ออย่างน้อยหนึ่งส่วน
    const { header, body, footer } = message.contents;
    expect(header ?? body ?? footer).toBeDefined();

    // altText ใช้ในหน้าแจ้งเตือน ห้ามว่างและห้ามยาวเกิน
    expect(message.altText.length).toBeGreaterThan(0);
    expect(message.altText.length).toBeLessThanOrEqual(MAX_ALT_TEXT);

    // box ที่ไม่มีลูกเลย LINE ปฏิเสธทั้งข้อความ
    for (const box of boxes(message)) {
      expect(box.contents.length).toBeGreaterThan(0);
    }

    for (const node of components(message)) {
      // ข้อความว่างก็โดนปฏิเสธเหมือนกัน
      if (node.type === "text") expect(node.text.length).toBeGreaterThan(0);
      // ปุ่มต้องมี action เสมอ
      if (node.type === "button") expect(node.action).toBeDefined();
    }
  });

  it("การ์ดที่ขอให้กดยืนยันมีปุ่มที่ footer ครบสองปุ่ม", () => {
    for (const [label, message] of CARDS) {
      if (!label.startsWith("ยืนยัน") || !isFlex(message)) continue;

      const buttons = components(message).filter((node) => node.type === "button");
      expect(buttons, label).toHaveLength(2);
    }
  });

  it("การ์ดที่เป็นแค่ผลลัพธ์ไม่มีปุ่มเลย", () => {
    for (const [label, message] of CARDS) {
      if (label.startsWith("ยืนยัน") || !isFlex(message)) continue;

      expect(components(message).filter((node) => node.type === "button"), label).toHaveLength(0);
    }
  });

  it("ลิงก์แผนที่กดได้ เพราะ Flex ไม่แปลง URL ในข้อความให้เอง", () => {
    const card = gameCard(game, 0, "🏸 เปิดรอบตีแล้ว");
    if (!isFlex(card)) throw new Error("การ์ดรอบตีต้องเป็น Flex");

    const linked = components(card).find(
      (node) => node.type === "text" && node.action?.type === "uri",
    );
    expect(linked).toBeDefined();
  });
});

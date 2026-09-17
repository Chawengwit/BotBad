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
import { makeBill, makeItem, makeShare, messageText } from "./helpers";

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

const payers = [
  { user_id: "1", display_name: "เชวง", amount_satang: 30000 },
  { user_id: "2", display_name: "Bank", amount_satang: 30000 },
];

const items = [
  makeItem(0, "ค่าคอร์ท", 60000, payers),
  makeItem(1, "ลูกแบด", 10000, [payers[0]!], 4),
];

const bill: BillRow = makeBill();
const bareBill: BillRow = makeBill({ game_id: null, promptpay: null, title: "ค่ากินข้าว" });

const share = (id: string, name: string, paid: boolean, paidBy: string | null = null): BillShareRow =>
  makeShare(id, name, paid, 35000, paidBy);

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
  ["ยืนยันส่งบิล", confirmBill(PENDING_ID, "รอบ พุธ 16 ก.ย.", items, 70000, mixedShares)],
  ["การ์ดบิล", billCard(bill, items, mixedShares, "💰 คิดเงินแล้ว")],
  ["การ์ดบิล ไม่มีพร้อมเพย์และจ่ายครบแล้ว", billCard(bareBill, items, allPaid)],
  ["ใครยังไม่จ่าย", unpaidList(bill, mixedShares)],
  ["ใครยังไม่จ่าย ตอนจ่ายครบแล้ว", unpaidList(bareBill, allPaid)],
  ["ยืนยันยกเลิกบิล", confirmCancelBill(PENDING_ID, bill, mixedShares)],
  ["ยืนยันยกเลิกบิล ตอนยังไม่มีใครจ่าย", confirmCancelBill(PENDING_ID, bill, [share("2", "Bank", false)])],
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

/**
 * การ์ดบิลขึ้นเฉพาะคนที่ยังไม่จ่าย
 * ก๊วนใหญ่ 20-30 คน ถ้าไล่ทุกชื่อทุกครั้งการ์ดจะยาวจนคนเลิกอ่าน
 * และคนที่จ่ายไปแล้วก็ไม่ได้ต้องทำอะไรต่อ
 */
describe("การ์ดบิลขึ้นเฉพาะคนที่ยังไม่จ่าย", () => {
  const four = [
    share("1", "เชวง", true),
    share("2", "Bank", true),
    share("3", "Arm", false),
    share("4", "ฮก", false),
  ];

  it("คนที่จ่ายแล้วไม่ขึ้นเป็นรายบรรทัด แต่บอกจำนวนไว้", () => {
    const body = messageText(billCard(bill, items, four));

    expect(body).toContain("Arm");
    expect(body).toContain("ฮก");
    expect(body).not.toContain("เชวง 350.00");
    expect(body).not.toContain("Bank 350.00");
    expect(body).toContain("จ่ายแล้ว 2 คน");
  });

  it("บอกยอดที่ยังไม่ได้รับ ไม่ใช่แค่จำนวนคน", () => {
    expect(messageText(billCard(bill, items, four))).toContain("ยังไม่ได้รับ 700.00");
  });

  it("ตอนเพิ่งส่งบิล ยังไม่มีใครจ่าย จึงขึ้นครบทุกคน", () => {
    const body = messageText(billCard(bill, items, [share("1", "เชวง", false), share("2", "Bank", false)]));

    expect(body).toContain("เชวง");
    expect(body).toContain("Bank");
    expect(body).not.toContain("จ่ายแล้ว");
  });

  it("จ่ายครบแล้วไม่มีรายชื่อเลย เหลือแค่บรรทัดสรุป", () => {
    const body = messageText(billCard(bill, items, allPaid));

    expect(body).toContain("จ่ายครบทุกคนแล้ว");
    expect(body).not.toContain("ยังไม่จ่าย");
  });

  it("การ์ดยืนยันก่อนส่งยังขึ้นครบทุกคน เพราะเป็นขั้นตรวจก่อนกด", () => {
    const body = messageText(confirmBill(PENDING_ID, "รอบ พุธ 16 ก.ย.", items, 70000, four));

    for (const name of ["เชวง", "Bank", "Arm", "ฮก"]) {
      expect(body, name).toContain(name);
    }
  });
});

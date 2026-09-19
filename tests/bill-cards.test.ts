import { describe, expect, it } from "vitest";
import type { FlexComponent, FlexMessage, FlexText } from "@/lib/line";
import {
  askNewBillDetails,
  askWhichBillToEdit,
  askWhichItemToRemove,
  billMenu,
  confirmBill,
  editBillCard,
} from "@/line/messages";
import { parsePostbackData } from "@/router/postback";
import { planBillEdit } from "@/services/bill.service";
import type { GameRow } from "@/repositories/types";
import { buttonActions, buttonLabels, makeBill, makeItem, makeShare, messageText } from "./helpers";

const PENDING_ID = "11111111-1111-4111-8111-111111111111";

const game: GameRow = {
  id: "1",
  line_group_id: "C123",
  created_by: "1",
  play_date: "2026-09-18",
  start_time: "18:00",
  duration_minutes: 120,
  court_count: 1,
  max_players: 6,
  status: "open",
  court_name: "คอร์ทสามย่าน",
  location_url: null,
  promptpay: null,
  edit_count: 0,
};

const bill = makeBill({ game_id: null, title: "ร้านโชคดี", total_satang: 96000 });
const payer = (id: string, name: string, amount: number) => ({ user_id: id, display_name: name, amount_satang: amount });
const items = [
  makeItem(0, "ค่าข้าว", 90000, [payer("1", "เชวง", 45000), payer("2", "แบงค์", 45000)]),
  makeItem(1, "ค่าน้ำ", 6000, [payer("2", "แบงค์", 6000)]),
];
const shares = [makeShare("1", "เชวง", true, 45000), makeShare("2", "แบงค์", true, 51000)];
const names = new Map([
  ["1", "เชวง"],
  ["2", "แบงค์"],
]);

/** ทุกข้อความในการ์ด เพื่อตรวจ property ของแต่ละบรรทัด */
function texts(message: FlexMessage): FlexText[] {
  const found: FlexText[] = [];
  const walk = (node: FlexComponent) => {
    if (node.type === "text") found.push(node);
    if (node.type === "box") node.contents.forEach(walk);
  };
  for (const part of [message.contents.header, message.contents.body, message.contents.footer]) {
    if (part) walk(part);
  }
  return found;
}

/** ค่าที่ปุ่มชื่อนี้ส่งกลับมา */
function valueOf(message: FlexMessage, label: string): string | undefined {
  const action = buttonActions(message).find((item) => item.label === label);
  const parsed = parsePostbackData(action?.data ?? "");
  return parsed?.action === "wizard" ? parsed.value : undefined;
}

/**
 * "คิดเงิน" เฉย ๆ ต้องถามก่อนว่าเงินเรื่องไหน ไม่เดาว่าเป็นค่ารอบ
 * กรณีจริงที่เจอ: มีรอบเปิดอยู่แต่ยังไม่มีใครลงชื่อ บอทตอบว่าหารไม่ได้ ทั้งที่คนสั่งอยากสร้างบิลค่าข้าว
 */
describe("การ์ดคิดเงินอะไรดี", () => {
  it("คิดค่ารอบได้และมีบิลให้แก้ ได้ครบสามทาง", () => {
    const card = billMenu(PENDING_ID, { games: [game], gameBlocked: null, editableBills: [bill] });

    expect(buttonLabels(card)).toEqual(["คิดค่ารอบ", "สร้างบิลใหม่", "แก้บิลเดิม"]);
    expect(valueOf(card, "คิดค่ารอบ")).toBe("game");
    expect(valueOf(card, "สร้างบิลใหม่")).toBe("new");
    expect(valueOf(card, "แก้บิลเดิม")).toBe("edit");
    // วันที่อยู่ในตัวการ์ด เพราะปุ่มครึ่งแถวใส่ป้ายยาวไม่พอ
    expect(messageText(card)).toContain("รอบ ศุกร์ 18 ก.ย. · คอร์ทสามย่าน");
  });

  it.each([
    ["ยังไม่มีใครลงชื่อ", "no_players", "รอบ ศุกร์ 18 ก.ย. ยังไม่มีใครลงชื่อ เลยยังคิดค่ารอบไม่ได้"],
    ["ไม่ใช่คนเปิดรอบ", "not_creator", "คิดค่ารอบ ศุกร์ 18 ก.ย. ได้เฉพาะคนที่เปิดรอบ"],
  ] as const)("%s: ไม่มีปุ่มคิดค่ารอบ แต่บอกเหตุผลไว้", (_label, reason, note) => {
    const card = billMenu(PENDING_ID, { games: [], gameBlocked: { game, reason }, editableBills: [bill] });

    expect(buttonLabels(card)).toEqual(["สร้างบิลใหม่", "แก้บิลเดิม"]);
    expect(messageText(card)).toContain(note);
  });

  it("ไม่มีบิลที่ตัวเองสร้าง ไม่มีปุ่มแก้บิลเดิม", () => {
    const card = billMenu(PENDING_ID, { games: [game], gameBlocked: null, editableBills: [] });
    expect(buttonLabels(card)).toEqual(["คิดค่ารอบ", "สร้างบิลใหม่"]);
  });
});

describe("ขอรายละเอียดบิลใหม่", () => {
  it("ยังไม่มีชื่อ ขอทั้งชื่อบิลและรายการ", () => {
    const body = messageText(askNewBillDetails());

    expect(body).toContain("พิมพ์ชื่อบิลกับรายการ");
    expect(body).toContain("บิล ร้านข้าวต้ม");
  });

  it("ตั้งชื่อมากับคำสั่งแล้ว ขอแค่รายการ", () => {
    const body = messageText(askNewBillDetails("ร้านโชคดี"));

    expect(body).toContain('รายการของบิล "ร้านโชคดี"');
    expect(body).not.toContain("บิล ร้านข้าวต้ม");
  });

  it("บอกเหตุผลที่คิดค่ารอบไม่ได้ไว้ด้านบน คนสั่งจะได้รู้ว่าทำไมไม่ได้ถามค่าคอร์ท", () => {
    expect(messageText(askNewBillDetails("", "รอบ ศุกร์ 18 ก.ย. ยังไม่มีใครลงชื่อ"))).toMatch(
      /^ℹ️ รอบ ศุกร์ 18 ก.ย. ยังไม่มีใครลงชื่อ/u,
    );
  });
});

describe("ตรวจบิลก่อนส่ง", () => {
  it("เลขพร้อมเพย์ขึ้นให้ตรวจก่อนกดส่ง", () => {
    const card = confirmBill(PENDING_ID, "ร้านโชคดี", items, 96000, shares, "0812345678");
    expect(messageText(card)).toContain("พร้อมเพย์ 081-234-5678");
  });

  it("ไม่มีเลขก็ไม่มีบรรทัดพร้อมเพย์", () => {
    expect(messageText(confirmBill(PENDING_ID, "ร้านโชคดี", items, 96000, shares))).not.toContain("พร้อมเพย์");
  });
});

describe("แก้บิลเดิม", () => {
  const untouched = planBillEdit(bill, items, shares, { added: [], removedIds: [] });
  const edited = planBillEdit(bill, items, shares, {
    added: [{ label: "ค่าน้ำแข็ง", amount: 40, payer_ids: [] }],
    removedIds: ["1"],
  });

  it("ยังไม่ได้แก้อะไร ยังไม่มีปุ่มยืนยัน", () => {
    const card = editBillCard(PENDING_ID, bill, untouched, names);
    expect(buttonLabels(card)).toEqual(["เพิ่มรายการ", "ลบรายการ", "ยกเลิก"]);
  });

  it("แก้แล้วมีปุ่มยืนยัน รายการใหม่มีป้าย และรายการที่จะลบถูกขีดฆ่า", () => {
    const card = editBillCard(PENDING_ID, bill, edited, names);

    expect(buttonLabels(card)).toEqual(["ยืนยันแก้บิล", "ยกเลิก", "เพิ่มรายการ", "ลบรายการ"]);
    expect(parsePostbackData(buttonActions(card)[0]?.data ?? "")?.action).toBe("confirm");
    expect(messageText(card)).toContain("ค่าน้ำแข็ง (ใหม่)");

    const struck = texts(card).filter((line) => line.decoration === "line-through");
    expect(struck.map((line) => line.text)).toEqual(["ค่าน้ำ", "60.00"]);
  });

  it("เตือนว่าใครจ่ายแล้วแต่ยอดเปลี่ยน จะกลับเป็นยังไม่จ่าย และบอกยอดรวมเดิม", () => {
    const body = messageText(editBillCard(PENDING_ID, bill, edited, names));

    expect(body).toContain("เชวง, แบงค์ บอกว่าจ่ายแล้ว แต่ยอดเปลี่ยน จะกลับเป็นยังไม่จ่าย");
    expect(body).toContain("เดิม 960.00");
  });

  it("เพิ่มครบจำนวนแล้วไม่มีปุ่มเพิ่ม เหลือรายการเดียวไม่มีปุ่มลบ", () => {
    const single = planBillEdit(bill, items, shares, { added: [], removedIds: ["1"] });
    const card = editBillCard(PENDING_ID, bill, single, names, false);

    expect(buttonLabels(card)).toEqual(["ยืนยันแก้บิล", "ยกเลิก"]);
  });

  it("เลือกบิลที่จะแก้ ป้ายยาวถูกตัดให้ไม่เกินที่ LINE รับ และเรียงแถวละปุ่ม", () => {
    const longTitle = "ค่ากินข้าวหลังตีที่ร้านข้าวต้มปากซอยหลังสนามแบดมินตันเจ้าเก่า";
    const card = askWhichBillToEdit(PENDING_ID, [bill, makeBill({ id: "2", title: longTitle })]);

    const labels = buttonLabels(card);
    expect(labels[0]).toBe("ร้านโชคดี");
    expect(labels[1]?.length).toBeLessThanOrEqual(40);
    expect(labels[1]?.endsWith("…")).toBe(true);
    expect(valueOf(card, labels[1] ?? "")).toBe("2");

    const rows = card.contents.footer?.contents ?? [];
    for (const row of rows) {
      expect(row.type === "box" ? row.contents.length : 0).toBe(1);
    }
  });

  it("เลือกรายการที่จะลบ มีทั้งรายการเดิม รายการใหม่ และปุ่มกลับ", () => {
    const card = askWhichItemToRemove(PENDING_ID, edited);

    expect(buttonLabels(card)).toEqual(["ค่าข้าว 900.00", "ค่าน้ำแข็ง 40.00", "กลับ"]);
    expect(valueOf(card, "ค่าข้าว 900.00")).toBe("0");
    expect(valueOf(card, "ค่าน้ำแข็ง 40.00")).toBe("new0");
    expect(valueOf(card, "กลับ")).toBe("back");
  });
});

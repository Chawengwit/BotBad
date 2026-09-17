import { describe, expect, it } from "vitest";
import { isAppError } from "@/errors/app-errors";
import {
  attachPayers,
  billDraftSchema,
  buildBillItems,
  parseItemLine,
  splitByItem,
  splitEqually,
  summarize,
  toSatang,
  totalOf,
} from "@/services/bill.service";
import type { BillShareRow } from "@/repositories/types";
import { makeShare } from "./helpers";

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return isAppError(error) ? error.code : "NOT_APP_ERROR";
  }
  return "NO_ERROR";
}

describe("toSatang", () => {
  it.each([
    [600, 60000],
    [25, 2500],
    [0.5, 50],
    [12.34, 1234],
    // 19.99 * 100 ในเลขทศนิยมได้ 1998.9999... ถ้าไม่ปัดจะกลายเป็น 1998
    [19.99, 1999],
  ])("%s บาท = %s สตางค์", (baht, satang) => {
    expect(toSatang(baht)).toBe(satang);
  });
});

describe("buildBillItems", () => {
  it("ค่าคอร์ทอย่างเดียวก็เป็นบิลได้", () => {
    const items = buildBillItems({ court_fee: 600 });
    expect(items).toEqual([
      { label: "ค่าคอร์ท", quantity: 1, unit_price_satang: 60000, amount_satang: 60000 },
    ]);
  });

  it("ลูกแบดคิดเป็นจำนวนคูณราคาต่อลูก", () => {
    const items = buildBillItems({ shuttle_count: 4, shuttle_price: 25 });
    expect(items[0]).toMatchObject({ label: "ลูกแบด", quantity: 4, amount_satang: 10000 });
  });

  it("ค่าอื่น ๆ ตั้งชื่อเองได้ และเรียงต่อท้าย", () => {
    const items = buildBillItems({
      court_fee: 600,
      shuttle_count: 4,
      shuttle_price: 25,
      other_items: [
        { label: "ค่าน้ำ", amount: 60 },
        { label: "ค่าเช่าไม้", amount: 100 },
      ],
    });

    expect(items.map((item) => item.label)).toEqual(["ค่าคอร์ท", "ลูกแบด", "ค่าน้ำ", "ค่าเช่าไม้"]);
    // 600 + (4 x 25) + 60 + 100 = 860 บาท
    expect(totalOf(items)).toBe(86000);
  });

  it("ไม่ใช้ลูกแบดก็ไม่ต้องมีรายการลูกแบด", () => {
    const items = buildBillItems({ court_fee: 600, shuttle_count: 0 });
    expect(items).toHaveLength(1);
  });

  it("บอกจำนวนลูกแต่ไม่บอกราคา ยังคิดเงินไม่ได้", () => {
    expect(errorCode(() => buildBillItems({ shuttle_count: 4 }))).toBe("AMOUNT_INVALID");
  });

  it("บิลที่ไม่มีรายการเลย ไม่ใช่บิล", () => {
    expect(errorCode(() => buildBillItems({}))).toBe("AMOUNT_INVALID");
  });
});

describe("billDraftSchema", () => {
  it.each([
    ["เงินติดลบ", { court_fee: -100 }],
    ["เงินเป็นศูนย์", { court_fee: 0 }],
    ["เกินเพดานต่อรายการ", { court_fee: 100_001 }],
    ["จำนวนลูกไม่ใช่จำนวนเต็ม", { shuttle_count: 2.5 }],
    ["จำนวนลูกเยอะเกินจริง", { shuttle_count: 999 }],
    ["ชื่อรายการว่าง", { other_items: [{ label: "   ", amount: 50 }] }],
    ["รายการอื่นเยอะเกินไป", { other_items: Array.from({ length: 6 }, () => ({ label: "x", amount: 1 })) }],
  ])("ปฏิเสธ %s", (_label, draft) => {
    expect(billDraftSchema.safeParse(draft).success).toBe(false);
  });

  it("รับค่าที่ถูกต้อง", () => {
    expect(
      billDraftSchema.safeParse({ court_fee: 600, shuttle_count: 4, shuttle_price: 25 }).success,
    ).toBe(true);
  });
});

describe("splitEqually", () => {
  it("หารลงตัว ทุกคนจ่ายเท่ากัน", () => {
    const shares = splitEqually(76000, ["1", "2", "3", "4", "5", "6", "7", "8"], "1");
    expect(shares.every((share) => share.amountSatang === 9500)).toBe(true);
  });

  it("หารไม่ลงตัว เศษตกที่คนคิดเงิน", () => {
    const shares = splitEqually(76000, ["1", "2", "3", "4", "5", "6", "7"], "3");

    expect(shares.find((share) => share.userId === "3")?.amountSatang).toBe(10858);
    expect(shares.filter((share) => share.userId !== "3").every((s) => s.amountSatang === 10857)).toBe(
      true,
    );
  });

  it("คนคิดเงินไม่ได้ลงชื่อเล่นด้วย เศษตกที่คนแรกที่ลงชื่อ", () => {
    const shares = splitEqually(100, ["7", "8", "9"], "99");
    expect(shares.map((share) => share.amountSatang)).toEqual([34, 33, 33]);
  });

  it.each([1, 2, 3, 5, 7, 8, 12, 13, 31, 64])(
    "ผลรวมของทุกคนเท่ากับยอดบิลเสมอ ที่ %s คน",
    (count) => {
      const ids = Array.from({ length: count }, (_, index) => String(index + 1));
      for (const total of [1, 99, 100, 76000, 76001, 999999]) {
        const shares = splitEqually(total, ids, "1");
        expect(shares.reduce((sum, share) => sum + share.amountSatang, 0)).toBe(total);
      }
    },
  );

  it("ไม่มีใครลงชื่อ หารไม่ได้", () => {
    expect(errorCode(() => splitEqually(1000, [], "1"))).toBe("NO_PLAYERS_TO_SPLIT");
  });
});

describe("summarize", () => {
  const share = (id: string, amount: number, paid: boolean): BillShareRow =>
    makeShare(id, `คนที่ ${id}`, paid, amount);

  it("แยกคนจ่ายแล้วกับคนค้าง พร้อมยอดที่ยังไม่ได้รับ", () => {
    const result = summarize([
      share("1", 9500, true),
      share("2", 9500, false),
      share("3", 9500, false),
    ]);

    expect(result.paid.map((item) => item.user_id)).toEqual(["1"]);
    expect(result.unpaid).toHaveLength(2);
    expect(result.unpaidTotalSatang).toBe(19000);
    expect(result.settled).toBe(false);
  });

  it("จ่ายครบทุกคนถึงจะนับว่าจบ", () => {
    expect(summarize([share("1", 9500, true), share("2", 9500, true)]).settled).toBe(true);
  });

  it("บิลที่ไม่มีใครอยู่ในนั้น ไม่นับว่าจ่ายครบ", () => {
    expect(summarize([]).settled).toBe(false);
  });
});

/**
 * หารทีละรายการ ไม่ใช่หารยอดรวม (PRP guests-split-bills-and-digest §5.5)
 * ยอดของแต่ละคนจึงไม่เท่ากันได้ ต่างจากบิลรุ่นก่อนที่ทุกคนเท่ากันเสมอ
 */
describe("splitByItem", () => {
  const item = (label: string, amount: number) => ({
    label,
    quantity: 1,
    unit_price_satang: amount,
    amount_satang: amount,
  });

  const amountOf = (shares: { userId: string; amountSatang: number }[], userId: string) =>
    shares.find((share) => share.userId === userId)?.amountSatang ?? 0;

  it("รายการที่เก็บบางคน คนนอกไม่ต้องจ่ายรายการนั้น", () => {
    const result = splitByItem(
      [
        { item: item("ค่าคอร์ท", 60000), payerIds: ["1", "2", "3"] },
        { item: item("ค่าน้ำ", 6000), payerIds: ["1", "2"] },
      ],
      "1",
    );

    expect(result.totalSatang).toBe(66000);
    expect(amountOf(result.shares, "1")).toBe(20000 + 3000);
    expect(amountOf(result.shares, "2")).toBe(20000 + 3000);
    expect(amountOf(result.shares, "3")).toBe(20000);
  });

  it("ผลรวมของทุกคนต้องเท่ากับยอดบิลเสมอ แม้หารไม่ลงตัว", () => {
    for (let people = 1; people <= 64; people += 1) {
      const ids = Array.from({ length: people }, (_, index) => String(index + 1));
      const result = splitByItem(
        [
          { item: item("ค่าคอร์ท", 76000), payerIds: ids },
          { item: item("ค่าน้ำ", 6000), payerIds: ids.slice(0, Math.max(1, people - 1)) },
        ],
        "1",
      );

      const sum = result.shares.reduce((total, share) => total + share.amountSatang, 0);
      expect(sum, `${people} คน`).toBe(result.totalSatang);

      for (const built of result.items) {
        const itemSum = built.payers.reduce((total, payer) => total + payer.amountSatang, 0);
        expect(itemSum, `${built.label} ${people} คน`).toBe(built.amountSatang);
      }
    }
  });

  it("เศษของแต่ละรายการตกที่คนสร้างบิล", () => {
    const result = splitByItem([{ item: item("ค่าคอร์ท", 10000), payerIds: ["1", "2", "3"] }], "2");

    expect(amountOf(result.shares, "2")).toBe(3334);
    expect(amountOf(result.shares, "1")).toBe(3333);
    expect(amountOf(result.shares, "3")).toBe(3333);
  });

  it("คนสร้างบิลไม่ได้ร่วมจ่ายรายการนั้น เศษตกที่คนแรกของรายการ", () => {
    const result = splitByItem([{ item: item("ค่าน้ำ", 10000), payerIds: ["2", "3", "4"] }], "1");

    expect(amountOf(result.shares, "2")).toBe(3334);
    expect(amountOf(result.shares, "3")).toBe(3333);
  });

  it("รายการที่ไม่มีคนร่วมจ่ายเลย คิดไม่ได้", () => {
    expect(
      errorCode(() => splitByItem([{ item: item("ค่าน้ำ", 6000), payerIds: [] }], "1")),
    ).toBe("NO_PLAYERS_TO_SPLIT");
  });

  it("บิลที่ไม่มีรายการเลย คิดไม่ได้", () => {
    expect(errorCode(() => splitByItem([], "1"))).toBe("AMOUNT_INVALID");
  });
});

/** รายการพิมพ์บรรทัดเดียว พร้อมระบุคนร่วมจ่ายได้ (PRP guests-split-bills-and-digest §5.3) */
describe("parseItemLine", () => {
  it.each([
    ["ค่าเช่าไม้ 100", "ค่าเช่าไม้", 100, []],
    ["ค่าน้ำ 60 เชวง แบงค์", "ค่าน้ำ", 60, ["เชวง", "แบงค์"]],
    ["ค่าน้ำ 60 บาท เชวง", "ค่าน้ำ", 60, ["เชวง"]],
    ["ค่าขนม 12.50", "ค่าขนม", 12.5, []],
    ["ค่าน้ำ 60, เชวง, แบงค์", "ค่าน้ำ", 60, ["เชวง", "แบงค์"]],
  ])("%s", (input, label, amount, payerNames) => {
    expect(parseItemLine(input)).toEqual({ label, amount, payerNames });
  });

  it.each(["", "ค่าน้ำ", "60", "ค่าน้ำ ศูนย์บาท"])("ไม่รับ %s", (input) => {
    expect(parseItemLine(input)).toBeNull();
  });

  it("จำนวนเงินเป็นตัวคั่น ชื่อรายการมีช่องว่างได้", () => {
    expect(parseItemLine("ค่า เช่า ไม้ 100 ฮก")).toEqual({
      label: "ค่า เช่า ไม้",
      amount: 100,
      payerNames: ["ฮก"],
    });
  });
});

describe("attachPayers", () => {
  const item = (label: string) => ({
    label,
    quantity: 1,
    unit_price_satang: 10000,
    amount_satang: 10000,
  });

  it("รายการที่ไม่ระบุคน เก็บทุกคนในบิล", () => {
    const result = attachPayers([item("ค่าคอร์ท")], {}, ["1", "2", "3"]);
    expect(result[0]?.payerIds).toEqual(["1", "2", "3"]);
  });

  it("รายการที่ระบุคน เก็บเฉพาะคนนั้น", () => {
    const result = attachPayers([item("ค่าน้ำ")], { ค่าน้ำ: ["1", "2"] }, ["1", "2", "3"]);
    expect(result[0]?.payerIds).toEqual(["1", "2"]);
  });

  it("บิลลอย ๆ ไม่มีรายชื่อตั้งต้น คนในบิลคือสหภาพของคนที่ถูกเอ่ยชื่อ", () => {
    const result = attachPayers(
      [item("ค่าข้าว"), item("ค่าน้ำ")],
      { ค่าข้าว: ["1", "2"] },
      [],
    );

    expect(result[0]?.payerIds).toEqual(["1", "2"]);
    // ค่าน้ำไม่ได้ระบุใคร จึงเก็บทุกคนที่อยู่ในบิล
    expect(result[1]?.payerIds).toEqual(["1", "2"]);
  });

  it("ไม่มีใครอยู่ในบิลเลย คิดไม่ได้", () => {
    expect(errorCode(() => attachPayers([item("ค่าน้ำ")], {}, []))).toBe("NO_PLAYERS_TO_SPLIT");
  });
});

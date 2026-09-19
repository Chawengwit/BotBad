import { getSql, type Queryable } from "@/lib/db";
import type { BillItem, BillItemRow, BillRow, BillShareRow } from "./types";

// เงินทุกจำนวนเก็บเป็นสตางค์ใน BIGINT ซึ่ง driver คืนมาเป็น string
// จึง cast เป็น int ทุก query เหมือนที่ game.repository ทำกับ play_date

export type NewBillShare = {
  userId: string;
  amountSatang: number;
};

export type NewBillItem = {
  label: string;
  quantity: number;
  unitPriceSatang: number;
  amountSatang: number;
  /** ใครร่วมจ่ายรายการนี้ พร้อมยอดของแต่ละคนหลังหารแล้ว */
  payers: NewBillShare[];
};

export type NewBill = {
  lineGroupId: string;
  gameId: string | null;
  createdBy: string;
  title: string;
  promptpay: string | null;
  items: NewBillItem[];
  totalSatang: number;
  shares: NewBillShare[];
};

/**
 * สร้างบิลพร้อมรายการ คนร่วมจ่ายรายรายการ และยอดรวมของทุกคน
 * ผู้เรียกต้องครอบ transaction ไว้เสมอ ล้มกลางทางต้องไม่เหลือบิลที่ไม่มียอดของใคร
 */
export async function insertBill(bill: NewBill, sql: Queryable): Promise<BillRow> {
  const rows = await sql<BillRow[]>`
    INSERT INTO bills (line_group_id, game_id, created_by, title, promptpay, items, total_satang)
    VALUES (
      ${bill.lineGroupId},
      ${bill.gameId},
      ${bill.createdBy},
      ${bill.title},
      ${bill.promptpay},
      ${sql.json([])},
      ${bill.totalSatang}
    )
    RETURNING id, line_group_id, game_id, created_by, title, status, promptpay,
              items, total_satang::int AS total_satang
  `;

  const created = rows[0];
  if (!created) throw new Error("insertBill returned no row");

  await insertBillItems(created.id, bill.items, sql);

  await sql`
    INSERT INTO bill_shares ${sql(
      bill.shares.map((share) => ({
        bill_id: created.id,
        user_id: share.userId,
        amount_satang: share.amountSatang,
      })),
    )}
  `;

  return created;
}

/** รายการพร้อมคนร่วมจ่ายของแต่ละรายการ position เรียงตามลำดับที่ส่งมา เริ่มที่ 0 */
async function insertBillItems(billId: string, items: NewBillItem[], sql: Queryable): Promise<void> {
  for (const [index, item] of items.entries()) {
    const itemRows = await sql<{ id: string }[]>`
      INSERT INTO bill_items (bill_id, position, label, quantity, unit_price_satang, amount_satang)
      VALUES (
        ${billId},
        ${index},
        ${item.label},
        ${item.quantity},
        ${item.unitPriceSatang},
        ${item.amountSatang}
      )
      RETURNING id
    `;

    const itemId = itemRows[0]?.id;
    if (!itemId) throw new Error("insertBillItems returned no row");

    await sql`
      INSERT INTO bill_item_payers ${sql(
        item.payers.map((payer) => ({
          bill_item_id: itemId,
          user_id: payer.userId,
          amount_satang: payer.amountSatang,
        })),
      )}
    `;
  }
}

/**
 * แทนรายการทั้งหมดของบิลด้วยชุดใหม่ ใช้ตอนแก้บิล (เพิ่ม/ลบรายการ)
 * ลบของเดิมทิ้งแล้วใส่ใหม่ทั้งชุด คนร่วมจ่ายของรายการเดิมหลุดตามด้วย ON DELETE CASCADE
 * ผู้เรียกต้องครอบ transaction ไว้เสมอ ล้มกลางทางต้องไม่เหลือบิลที่ไม่มีรายการ
 */
export async function replaceBillItems(
  billId: string,
  items: NewBillItem[],
  totalSatang: number,
  sql: Queryable,
): Promise<void> {
  await sql`DELETE FROM bill_items WHERE bill_id = ${billId}`;
  await insertBillItems(billId, items, sql);
  await sql`UPDATE bills SET total_satang = ${totalSatang}, updated_at = now() WHERE id = ${billId}`;
}

/**
 * ปรับยอดของทุกคนในบิลให้ตรงกับชุดใหม่ ใช้ตอนแก้บิล
 *
 * - ยอดเท่าเดิม → สถานะการจ่ายเหมือนเดิม
 * - ยอดเปลี่ยน → กลับเป็นยังไม่จ่าย เพราะที่บอกว่าจ่ายไปแล้วไม่ใช่ยอดนี้
 * - คนใหม่ → ยังไม่จ่าย, คนที่ไม่เหลือรายการไหนแล้ว → ออกจากบิล
 *
 * ทางขวาของ SET อ่านค่าเดิมของแถวทั้งหมด จึงเทียบยอดเก่ากับยอดใหม่ได้ในคำสั่งเดียว
 */
export async function syncBillShares(
  billId: string,
  shares: NewBillShare[],
  sql: Queryable,
): Promise<void> {
  await sql`
    INSERT INTO bill_shares ${sql(
      shares.map((share) => ({
        bill_id: billId,
        user_id: share.userId,
        amount_satang: share.amountSatang,
      })),
    )}
    ON CONFLICT (bill_id, user_id) DO UPDATE
    SET amount_satang = EXCLUDED.amount_satang,
        paid = bill_shares.paid AND bill_shares.amount_satang = EXCLUDED.amount_satang,
        paid_at = CASE WHEN bill_shares.amount_satang = EXCLUDED.amount_satang THEN bill_shares.paid_at END,
        paid_by = CASE WHEN bill_shares.amount_satang = EXCLUDED.amount_satang THEN bill_shares.paid_by END
  `;

  // เทียบเป็นข้อความ เพราะ id ที่ driver คืนมาเป็น string ส่วนคอลัมน์เป็น BIGINT
  await sql`
    DELETE FROM bill_shares
    WHERE bill_id = ${billId}
      AND user_id::text <> ALL(${shares.map((share) => share.userId)})
  `;
}

/**
 * บิลที่ยังใช้งานอยู่ของกลุ่ม เรียงใบใหม่สุดก่อน
 * ไม่ผูกกับสถานะของรอบ เพราะปิดรอบไปแล้วก็ยังตามเก็บเงินกันต่อได้ (PRP bill-splitting §5.4)
 */
export async function listActiveBills(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<BillRow[]> {
  return sql<BillRow[]>`
    SELECT id, line_group_id, game_id, created_by, title, status, promptpay,
           items, total_satang::int AS total_satang
    FROM bills
    WHERE line_group_id = ${lineGroupId} AND status = 'sent'
    ORDER BY id DESC
  `;
}

/** บิลที่ยังใช้งานอยู่ พร้อมว่าใครยังค้างและใครจ่ายแล้ว */
export type ActiveBill = BillRow & { unpaid_user_ids: string[]; paid_user_ids: string[] };

/**
 * บิลที่ยังใช้งานอยู่ของกลุ่ม พร้อมว่าใครยังค้างใครจ่ายแล้ว เรียงใบใหม่สุดก่อน
 * ใช้เลือกบิลตอนผู้ใช้ไม่ได้ระบุชื่อ อ่านทีเดียวทั้งกลุ่ม ไม่ต้องไล่อ่านยอดทีละใบ
 */
export async function listActiveBillsWithPayers(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<ActiveBill[]> {
  return sql<ActiveBill[]>`
    SELECT b.id, b.line_group_id, b.game_id, b.created_by, b.title, b.status, b.promptpay,
           b.items, b.total_satang::int AS total_satang,
           COALESCE(array_agg(bs.user_id::text) FILTER (WHERE NOT bs.paid), '{}') AS unpaid_user_ids,
           COALESCE(array_agg(bs.user_id::text) FILTER (WHERE bs.paid), '{}') AS paid_user_ids
    FROM bills b
    LEFT JOIN bill_shares bs ON bs.bill_id = b.id
    WHERE b.line_group_id = ${lineGroupId} AND b.status = 'sent'
    GROUP BY b.id
    ORDER BY b.id DESC
  `;
}

/**
 * บิลที่คนนี้แก้ได้: ยังเปิดอยู่ เขาเป็นคนสร้าง และมีรายการอยู่ในตาราง bill_items
 * บิลที่สร้างก่อน migration 013 เก็บรายการไว้ใน jsonb เท่านั้น แก้แล้วยอดเดิมจะหายหมด จึงไม่นับ
 */
export async function listEditableBills(
  lineGroupId: string,
  createdBy: string,
  sql: Queryable = getSql(),
): Promise<BillRow[]> {
  return sql<BillRow[]>`
    SELECT b.id, b.line_group_id, b.game_id, b.created_by, b.title, b.status, b.promptpay,
           b.items, b.total_satang::int AS total_satang
    FROM bills b
    WHERE b.line_group_id = ${lineGroupId}
      AND b.status = 'sent'
      AND b.created_by = ${createdBy}
      AND EXISTS (SELECT 1 FROM bill_items bi WHERE bi.bill_id = b.id)
    ORDER BY b.id DESC
  `;
}

/** บิลใบเดียวของกลุ่มที่ชื่อตรงกัน ใช้ตอนผู้ใช้ระบุชื่อบิลมา */
export async function findActiveBillByTitle(
  lineGroupId: string,
  title: string,
  sql: Queryable = getSql(),
): Promise<BillRow | null> {
  const rows = await sql<BillRow[]>`
    SELECT id, line_group_id, game_id, created_by, title, status, promptpay,
           items, total_satang::int AS total_satang
    FROM bills
    WHERE line_group_id = ${lineGroupId}
      AND status = 'sent'
      AND lower(btrim(title)) = lower(btrim(${title}))
  `;
  return rows[0] ?? null;
}

export async function findBillById(
  billId: string,
  sql: Queryable = getSql(),
): Promise<BillRow | null> {
  const rows = await sql<BillRow[]>`
    SELECT id, line_group_id, game_id, created_by, title, status, promptpay,
           items, total_satang::int AS total_satang
    FROM bills
    WHERE id = ${billId}
  `;
  return rows[0] ?? null;
}

/** บิลที่ยังใช้งานอยู่ของรอบตีหนึ่ง ๆ รอบหนึ่งมีได้หลายใบแล้ว */
export async function listActiveBillsByGame(
  gameId: string,
  sql: Queryable = getSql(),
): Promise<BillRow[]> {
  return sql<BillRow[]>`
    SELECT id, line_group_id, game_id, created_by, title, status, promptpay,
           items, total_satang::int AS total_satang
    FROM bills
    WHERE game_id = ${gameId} AND status = 'sent'
    ORDER BY id DESC
  `;
}

type ItemPayerRow = {
  bill_item_id: string;
  user_id: string;
  display_name: string;
  amount_satang: number;
};

/** รายการของบิลพร้อมคนร่วมจ่ายของแต่ละรายการ */
export async function listBillItems(
  billId: string,
  sql: Queryable = getSql(),
): Promise<BillItemRow[]> {
  const [items, payers] = await Promise.all([
    sql<Omit<BillItemRow, "payers">[]>`
      SELECT id,
             bill_id,
             position,
             label,
             quantity,
             unit_price_satang::int AS unit_price_satang,
             amount_satang::int AS amount_satang
      FROM bill_items
      WHERE bill_id = ${billId}
      ORDER BY position
    `,
    sql<ItemPayerRow[]>`
      SELECT bip.bill_item_id,
             bip.user_id,
             u.display_name,
             bip.amount_satang::int AS amount_satang
      FROM bill_item_payers bip
      JOIN bill_items bi ON bi.id = bip.bill_item_id
      JOIN users u ON u.id = bip.user_id
      WHERE bi.bill_id = ${billId}
      ORDER BY bip.user_id
    `,
  ]);

  return items.map((item) => ({
    ...item,
    payers: payers
      .filter((payer) => payer.bill_item_id === item.id)
      .map(({ user_id, display_name, amount_satang }) => ({ user_id, display_name, amount_satang })),
  }));
}

export async function listBillShares(
  billId: string,
  sql: Queryable = getSql(),
): Promise<BillShareRow[]> {
  return sql<BillShareRow[]>`
    SELECT bs.id,
           bs.bill_id,
           bs.user_id,
           bs.amount_satang::int AS amount_satang,
           bs.paid,
           bs.paid_by,
           u.display_name,
           payer.display_name AS paid_by_name
    FROM bill_shares bs
    JOIN users u ON u.id = bs.user_id
    LEFT JOIN users payer ON payer.id = bs.paid_by
    WHERE bs.bill_id = ${billId}
    ORDER BY bs.id
  `;
}

/**
 * บันทึกว่าคนนี้จ่ายแล้วหรือยัง คืน true เมื่อสถานะเปลี่ยนจริง
 * กดซ้ำไม่ใช่ error แค่ไม่มีอะไรเปลี่ยน (PRP bill-splitting §12)
 */
export async function markSharePaid(
  billId: string,
  userId: string,
  paid: boolean,
  paidBy: string | null,
  sql: Queryable = getSql(),
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE bill_shares
    SET paid = ${paid},
        paid_at = ${paid ? sql`now()` : sql`NULL`},
        paid_by = ${paid ? paidBy : null}
    WHERE bill_id = ${billId} AND user_id = ${userId} AND paid <> ${paid}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function cancelBill(billId: string, sql: Queryable = getSql()): Promise<void> {
  await sql`UPDATE bills SET status = 'cancelled', updated_at = now() WHERE id = ${billId}`;
}

/** ราคาลูกแบดที่กลุ่มนี้ใช้ครั้งล่าสุด เอาไว้เสนอเป็นตัวเลือกแรกตอนคิดเงินรอบใหม่ */
export async function findLastShuttlePrice(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<number | null> {
  const rows = await sql<{ unit_price_satang: number }[]>`
    SELECT bi.unit_price_satang::int AS unit_price_satang
    FROM bill_items bi
    JOIN bills b ON b.id = bi.bill_id
    WHERE b.line_group_id = ${lineGroupId} AND bi.label = 'ลูกแบด' AND bi.quantity > 0
    ORDER BY bi.id DESC
    LIMIT 1
  `;
  return rows[0]?.unit_price_satang ?? null;
}

/**
 * เลขพร้อมเพย์ที่คนนี้เคยใช้ล่าสุด เสนอเป็นตัวเลือกแรกตอนสร้างบิลใหม่ (PRP §5.2.1)
 * ดูทั้งบิลและรอบตีที่เขาเป็นคนสร้าง คนที่เคยแต่เปิดรอบก็มีเลขให้เสนอตั้งแต่บิลแรก
 * ไม่ใช้เลขล่าสุดของกลุ่ม เพราะเงินจะไปเข้าบัญชีคนที่ไม่ได้สร้างบิล
 */
export async function findLastPromptPayOf(
  createdBy: string,
  sql: Queryable = getSql(),
): Promise<string | null> {
  const rows = await sql<{ promptpay: string }[]>`
    SELECT promptpay
    FROM (
      SELECT promptpay, created_at FROM bills WHERE created_by = ${createdBy} AND promptpay IS NOT NULL
      UNION ALL
      SELECT promptpay, created_at FROM games WHERE created_by = ${createdBy} AND promptpay IS NOT NULL
    ) used
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0]?.promptpay ?? null;
}

export type { BillItem };

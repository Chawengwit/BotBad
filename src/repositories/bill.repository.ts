import { getSql, type Queryable } from "@/lib/db";
import type { BillItem, BillRow, BillShareRow } from "./types";

// เงินทุกจำนวนเก็บเป็นสตางค์ใน BIGINT ซึ่ง driver คืนมาเป็น string
// จึง cast เป็น int ทุก query เหมือนที่ game.repository ทำกับ play_date

export type NewBillShare = {
  userId: string;
  amountSatang: number;
};

export type NewBill = {
  gameId: string;
  createdBy: string;
  items: BillItem[];
  totalSatang: number;
  shares: NewBillShare[];
};

/** สร้างบิลพร้อมยอดของทุกคน ผู้เรียกต้องครอบ transaction ไว้เสมอ */
export async function insertBill(bill: NewBill, sql: Queryable): Promise<BillRow> {
  const rows = await sql<BillRow[]>`
    INSERT INTO bills (game_id, created_by, items, total_satang)
    VALUES (${bill.gameId}, ${bill.createdBy}, ${sql.json(bill.items)}, ${bill.totalSatang})
    RETURNING id,
              game_id,
              created_by,
              status,
              items,
              total_satang::int AS total_satang
  `;

  const created = rows[0];
  if (!created) throw new Error("insertBill returned no row");

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

/**
 * บิลที่ยังใช้งานอยู่ของกลุ่ม
 * ไม่ผูกกับสถานะของรอบ เพราะปิดรอบไปแล้วก็ยังตามเก็บเงินกันต่อได้ (PRP §5.4)
 */
export async function findActiveBill(
  lineGroupId: string,
  sql: Queryable = getSql(),
): Promise<BillRow | null> {
  const rows = await sql<BillRow[]>`
    SELECT b.id,
           b.game_id,
           b.created_by,
           b.status,
           b.items,
           b.total_satang::int AS total_satang
    FROM bills b
    JOIN games g ON g.id = b.game_id
    WHERE g.line_group_id = ${lineGroupId} AND b.status = 'sent'
    ORDER BY b.id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

/** บิลที่ยังใช้งานอยู่ของรอบตีหนึ่ง ๆ ใช้ตอนจะสร้างบิลใหม่และตอนปิดรอบ */
export async function findActiveBillByGame(
  gameId: string,
  sql: Queryable = getSql(),
): Promise<BillRow | null> {
  const rows = await sql<BillRow[]>`
    SELECT id,
           game_id,
           created_by,
           status,
           items,
           total_satang::int AS total_satang
    FROM bills
    WHERE game_id = ${gameId} AND status = 'sent'
  `;
  return rows[0] ?? null;
}

/** ยอดของแต่ละคนพร้อมชื่อ เรียงตามลำดับที่ลงชื่อไว้ในรอบ */
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
           u.display_name
    FROM bill_shares bs
    JOIN bills b ON b.id = bs.bill_id
    JOIN users u ON u.id = bs.user_id
    LEFT JOIN game_players gp ON gp.game_id = b.game_id AND gp.user_id = bs.user_id
    WHERE bs.bill_id = ${billId}
    ORDER BY gp.joined_at NULLS LAST, bs.id
  `;
}

/**
 * เปลี่ยนสถานะการจ่ายของคนคนเดียว
 * เขียนแถวเดียวและกันเขียนซ้ำด้วย paid <> ค่าใหม่ จึงไม่ต้อง lock อะไร
 * คืน false เมื่อสถานะเป็นแบบนั้นอยู่แล้ว (กดซ้ำ ไม่ใช่ error)
 */
export async function markSharePaid(
  billId: string,
  userId: string,
  paid: boolean,
  sql: Queryable = getSql(),
): Promise<boolean> {
  const rows = await sql`
    UPDATE bill_shares
    SET paid = ${paid},
        paid_at = CASE WHEN ${paid} THEN now() ELSE NULL END
    WHERE bill_id = ${billId} AND user_id = ${userId} AND paid <> ${paid}
    RETURNING id
  `;
  return rows.length > 0;
}

export async function cancelBill(billId: string, sql: Queryable = getSql()): Promise<void> {
  await sql`
    UPDATE bills
    SET status = 'cancelled', updated_at = now()
    WHERE id = ${billId}
  `;
}

/**
 * Type ของผลลัพธ์แต่ละ query เขียนเอง ไม่มี ORM มา generate ให้ (spec §20)
 *
 * หมายเหตุเรื่องชนิดข้อมูลที่ driver คืนมา:
 * - BIGSERIAL / BIGINT → string (กันค่าเกินช่วงของ number)
 * - INT → number
 * - TIME → string เช่น "19:00:00"
 * - DATE → Date ซึ่งเพี้ยนได้เวลาแปลง timezone จึงต้อง cast เป็น text ใน query เสมอ
 */

export type UserRow = {
  id: string;
  line_user_id: string;
  display_name: string;
};

export type GameStatus = "open" | "cancelled" | "completed";

export type GameRow = {
  id: string;
  line_group_id: string;
  created_by: string;
  /** รูปแบบ YYYY-MM-DD */
  play_date: string;
  /** รูปแบบ HH:MM */
  start_time: string;
  duration_minutes: number;
  court_count: number;
  max_players: number;
  status: GameStatus;
  /** ชื่อคอร์ทที่ไปเล่น รอบที่เปิดก่อนมีฟีเจอร์นี้จะเป็น null */
  court_name: string | null;
  /** ลิงก์แผนที่ ใส่หรือไม่ใส่ก็ได้ */
  location_url: string | null;
  /** เลขพร้อมเพย์ที่จะให้โอนตอนคิดเงิน ตัวเลขล้วน 10 หรือ 13 หลัก */
  promptpay: string | null;
};

export type BillStatus = "sent" | "cancelled";

/** หนึ่งรายการในบิล เช่น ค่าคอร์ท หรือ ลูกแบด 4 ลูก ลูกละ 25 บาท */
export type BillItem = {
  label: string;
  quantity: number;
  unit_price_satang: number;
  amount_satang: number;
};

export type BillRow = {
  id: string;
  game_id: string;
  created_by: string;
  status: BillStatus;
  items: BillItem[];
  total_satang: number;
};

export type BillShareRow = {
  id: string;
  bill_id: string;
  user_id: string;
  amount_satang: number;
  paid: boolean;
  display_name: string;
};

export type PlayerStatus = "joined" | "cancelled";

export type GamePlayerRow = {
  id: string;
  game_id: string;
  user_id: string;
  status: PlayerStatus;
  display_name: string;
};

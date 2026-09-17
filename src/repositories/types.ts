/**
 * Type ของผลลัพธ์แต่ละ query เขียนเอง ไม่มี ORM มา generate ให้ (spec §20)
 *
 * หมายเหตุเรื่องชนิดข้อมูลที่ driver คืนมา:
 * - BIGSERIAL / BIGINT → string (กันค่าเกินช่วงของ number)
 * - INT → number
 * - TIME → string เช่น "19:00:00"
 * - DATE → Date ซึ่งเพี้ยนได้เวลาแปลง timezone จึงต้อง cast เป็น text ใน query เสมอ
 */

/**
 * คนหนึ่งคนในระบบ เป็นได้สองแบบ (PRP guests-split-bills-and-digest §4.1)
 *   สมาชิก LINE → line_user_id มีค่า, line_group_id เป็น null (คนเดียวอยู่ได้หลายกลุ่ม)
 *   แขก        → line_user_id เป็น null, line_group_id มีค่า (ผูกกับกลุ่มที่พามา)
 */
export type UserRow = {
  id: string;
  line_user_id: string | null;
  line_group_id: string | null;
  display_name: string;
};

export function isGuest(user: UserRow): boolean {
  return user.line_user_id === null;
}

/**
 * คนที่ส่ง event เข้ามา มี line_user_id เสมอ
 * แขกเป็นได้แค่เป้าหมายของคำสั่ง สั่งงานเองไม่ได้เพราะไม่มี LINE อยู่ในกลุ่ม
 */
export type LineUserRow = UserRow & { line_user_id: string };

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
  /** จำนวนครั้งที่แก้ไขรอบนี้ ใช้ให้บอทแซวคนที่เปลี่ยนไปเปลี่ยนมา */
  edit_count: number;
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
  line_group_id: string;
  /** null = บิลลอย ๆ ไม่ผูกกับรอบตี (PRP guests-split-bills-and-digest §5) */
  game_id: string | null;
  created_by: string;
  /** ชื่อบิล ใช้อ้างถึงเมื่อกลุ่มมีบิลเปิดพร้อมกันหลายใบ */
  title: string;
  status: BillStatus;
  /** เลขพร้อมเพย์ของบิลนี้ คัดลอกมาตอนสร้าง จะได้ไม่เปลี่ยนตามการแก้รอบทีหลัง */
  promptpay: string | null;
  items: BillItem[];
  total_satang: number;
};

/** รายการในบิล พร้อมรายชื่อคนร่วมจ่ายของรายการนั้น */
export type BillItemRow = {
  id: string;
  bill_id: string;
  position: number;
  label: string;
  quantity: number;
  unit_price_satang: number;
  amount_satang: number;
  payers: { user_id: string; display_name: string; amount_satang: number }[];
};

export type BillShareRow = {
  id: string;
  bill_id: string;
  user_id: string;
  amount_satang: number;
  paid: boolean;
  display_name: string;
  /** ใครเป็นคนบอกว่าจ่ายแล้ว null = เจ้าตัวบอกเอง */
  paid_by: string | null;
  paid_by_name: string | null;
};

export type PlayerStatus = "joined" | "cancelled";

export type GamePlayerRow = {
  id: string;
  game_id: string;
  user_id: string;
  status: PlayerStatus;
  display_name: string;
  /** คนที่ลงชื่อให้ null = ลงเอง */
  added_by: string | null;
};

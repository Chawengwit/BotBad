-- บิลแยกจากรอบตี แยกเก็บรายคนต่อรายการ และจ่ายแทนกันได้
-- (docs/PRP/guests-split-bills-and-digest.md §5)

-- บิลยืนจากกลุ่ม ไม่ใช่จากรอบ เพราะบิลลอย ๆ ไม่มีรอบให้ผูก
ALTER TABLE bills ADD COLUMN line_group_id TEXT;
UPDATE bills SET line_group_id = (SELECT g.line_group_id FROM games g WHERE g.id = bills.game_id);
ALTER TABLE bills ALTER COLUMN line_group_id SET NOT NULL;
ALTER TABLE bills ALTER COLUMN game_id DROP NOT NULL;

-- ชื่อบิล ใช้อ้างถึงเมื่อกลุ่มมีบิลเปิดพร้อมกันหลายใบ
ALTER TABLE bills ADD COLUMN title TEXT NOT NULL DEFAULT '';
UPDATE bills SET title = 'บิลรอบเก่า ' || id WHERE title = '';

CREATE UNIQUE INDEX uq_bills_open_title
  ON bills (line_group_id, title)
  WHERE status = 'sent';

-- เลขพร้อมเพย์ของบิลเอง บิลลอย ๆ ไม่มีรอบให้ดึง และการคัดลอกมาเก็บไว้
-- ทำให้บิลที่ส่งไปแล้วไม่เปลี่ยนตามการแก้รอบทีหลัง (PRP §5.2.1)
ALTER TABLE bills ADD COLUMN promptpay TEXT;
ALTER TABLE bills ADD CONSTRAINT bills_promptpay_check
  CHECK (promptpay IS NULL OR promptpay ~ '^([0-9]{10}|[0-9]{13})$');
UPDATE bills SET promptpay = (SELECT g.promptpay FROM games g WHERE g.id = bills.game_id);

-- เลิกบังคับ 1 รอบ 1 บิล รอบหนึ่งมีได้ทั้งค่าคอร์ทและค่ากินข้าวหลังตี
DROP INDEX uq_bills_one_active_per_game;

-- รายการในบิล ย้ายจาก jsonb มาเป็นตาราง เพราะแต่ละรายการมีรายชื่อคนร่วมจ่ายของตัวเองแล้ว
-- (เหตุผลเดิมที่เลือก jsonb คือ "ไม่เคย query ทีละรายการ" ซึ่งไม่จริงอีกต่อไป)
CREATE TABLE bill_items (
  id                 BIGSERIAL PRIMARY KEY,
  bill_id            BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  position           INT NOT NULL,
  label              TEXT NOT NULL,
  quantity           INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_satang  BIGINT NOT NULL CHECK (unit_price_satang >= 0),
  amount_satang      BIGINT NOT NULL CHECK (amount_satang > 0),
  UNIQUE (bill_id, position)
);

-- ใครร่วมจ่ายรายการไหน และคนละเท่าไหร่หลังหารแล้ว
CREATE TABLE bill_item_payers (
  bill_item_id   BIGINT NOT NULL REFERENCES bill_items(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  amount_satang  BIGINT NOT NULL CHECK (amount_satang >= 0),
  PRIMARY KEY (bill_item_id, user_id)
);

-- ใครเป็นคนบอกว่าจ่ายแล้ว NULL = เจ้าตัวบอกเอง
-- แขกพิมพ์เองไม่ได้ ต้องมีคนกดแทนเสมอ (PRP §5.6)
ALTER TABLE bill_shares ADD COLUMN paid_by BIGINT REFERENCES users(id);

-- bills.items (jsonb) ยังเก็บไว้ก่อน บิลเก่าที่สร้างก่อน migration นี้ยังอ่านผ่านช่องนั้น
ALTER TABLE bills ALTER COLUMN items SET DEFAULT '[]';

-- บิลค่าใช้จ่ายของรอบตี (docs/PRP/bill-splitting.md §11)
-- 1 รอบมีบิลที่ยังใช้งานอยู่ได้ใบเดียว ยกเลิกแล้วคิดใหม่ได้
--
-- items เก็บเป็น jsonb เพราะมี 1-5 รายการ เขียนครั้งเดียวตอนสร้าง อ่านยกชุดเสมอ
-- และแก้ไม่ได้หลังส่งบิล ตารางแยกจึงมีแต่ join เพิ่มโดยไม่ได้อะไรกลับมา
-- ทุกจำนวนเงินเป็นสตางค์ (integer) ห้ามเก็บเงินเป็นทศนิยม
CREATE TABLE bills (
  id            BIGSERIAL PRIMARY KEY,
  game_id       BIGINT NOT NULL REFERENCES games(id),
  created_by    BIGINT NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL DEFAULT 'sent'
                CHECK (status IN ('sent', 'cancelled')),
  items         JSONB NOT NULL,
  total_satang  BIGINT NOT NULL CHECK (total_satang > 0),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1 รอบตี มีบิลที่ยังไม่ถูกยกเลิกได้ใบเดียว
CREATE UNIQUE INDEX uq_bills_one_active_per_game
  ON bills (game_id)
  WHERE status = 'sent';

-- ยอดของแต่ละคน ตัดเก็บไว้ตอนสร้างบิล (snapshot) ถอนชื่อทีหลังก็ไม่กระทบ
CREATE TABLE bill_shares (
  id             BIGSERIAL PRIMARY KEY,
  bill_id        BIGINT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id),
  amount_satang  BIGINT NOT NULL CHECK (amount_satang >= 0),
  paid           BOOLEAN NOT NULL DEFAULT false,
  paid_at        TIMESTAMPTZ,
  UNIQUE (bill_id, user_id)
);

CREATE INDEX idx_bill_shares_bill ON bill_shares (bill_id);

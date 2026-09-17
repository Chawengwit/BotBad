-- แขกที่ไม่ได้อยู่ใน LINE Group และการลงชื่อแทนกัน
-- (docs/PRP/guests-split-bills-and-digest.md §4)
--
-- เก็บแขกเป็นแถวใน users ที่ line_user_id เป็น NULL แทนที่จะแยกตาราง
-- เพราะ game_players และ bill_shares join users อยู่แล้วทุก query
-- ถ้าแยกตารางต้องทำให้สองตารางนั้นมีสองคอลัมน์ แล้วแก้ทุก JOIN ทั้งระบบ

ALTER TABLE users ALTER COLUMN line_user_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN line_group_id TEXT;

-- เป็นได้อย่างเดียว: สมาชิก LINE (อยู่ได้หลายกลุ่ม) หรือแขกของกลุ่มใดกลุ่มหนึ่ง
ALTER TABLE users ADD CONSTRAINT users_identity_check CHECK (
  (line_user_id IS NOT NULL AND line_group_id IS NULL) OR
  (line_user_id IS NULL AND line_group_id IS NOT NULL)
);

-- แขกชื่อซ้ำในกลุ่มเดียวกันไม่ได้ "ฮกพากิ้ฟมาทุกอาทิตย์" จะได้ใช้แถวเดิม
-- ประวัติการจ่ายเงินของแขกจึงตามตัวไปด้วย ไม่งอกคนใหม่ทุกสัปดาห์
CREATE UNIQUE INDEX uq_users_guest_per_group
  ON users (line_group_id, display_name)
  WHERE line_user_id IS NULL;

-- ใครเป็นคนลงชื่อให้ NULL = ลงเอง
-- ใช้ตัดสินสิทธิ์ถอนชื่อ: เจ้าตัวหรือคนที่ลงให้เท่านั้น (PRP §4.3)
ALTER TABLE game_players ADD COLUMN added_by BIGINT REFERENCES users(id);

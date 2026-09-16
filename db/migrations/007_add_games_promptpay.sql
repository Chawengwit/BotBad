-- เลขพร้อมเพย์ของรอบตี ใช้ตอนคิดเงินเพื่อบอกว่าให้โอนไปที่ไหน (docs/PRP/bill-splitting.md §6)
-- เก็บเป็นตัวเลขล้วน: 10 หลัก (เบอร์มือถือ) หรือ 13 หลัก (เลขบัตรประชาชน)
-- เป็นข้อความที่ผู้ใช้พิมพ์เอง ไม่มีการตรวจกับธนาคาร และบอทไม่แตะเงินจริง
ALTER TABLE games ADD COLUMN promptpay TEXT;
ALTER TABLE games ADD CONSTRAINT games_promptpay_check
  CHECK (promptpay IS NULL OR promptpay ~ '^([0-9]{10}|[0-9]{13})$');

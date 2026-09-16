-- เดิมจำนวนคนสูงสุดผูกกับจำนวนคอร์ทตายตัว (games_check: max_players = court_count * 8)
-- ตอนนี้ให้ผู้เปิดรอบตั้งเองได้ โดยยังใช้ court_count * 8 เป็นค่าตั้งต้น
ALTER TABLE games DROP CONSTRAINT games_check;
ALTER TABLE games ADD CONSTRAINT games_max_players_check
  CHECK (max_players BETWEEN 2 AND 64);

-- สถานที่: ชื่อคอร์ทบังคับใส่ตั้งแต่นี้ไป (รอบที่เปิดไว้ก่อนหน้ายังว่างได้) ส่วนลิงก์แผนที่ข้ามได้
ALTER TABLE games ADD COLUMN court_name TEXT;
ALTER TABLE games ADD COLUMN location_url TEXT;

-- เปิดได้หลายรอบพร้อมกัน (PRP multi-open-rounds §7)
-- เลิกบังคับ 1 กลุ่ม 1 รอบ จำนวนสูงสุด 3 รอบบังคับในโค้ด โดยล็อกกลุ่มก่อนนับตอนยืนยันเปิดรอบ
DROP INDEX uq_games_one_open_per_group;

-- การ์ด "รอบไหน?" ใช้ pending_actions ตัวเดิม
-- CHECK ที่ migration 016 ตั้งไว้รับแค่ 8 ค่า ถ้าไม่ขยายก่อน insert จะไม่ผ่าน
ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_action_type_check;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_action_type_check
  CHECK (action_type IN (
    'create_game', 'edit_game', 'cancel_game', 'close_game',
    'create_bill', 'cancel_bill', 'edit_bill', 'leave_players', 'choose_game'
  ));

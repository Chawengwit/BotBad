-- wizard คิดเงินและการยกเลิกบิลใช้ pending_actions ตัวเดิม (docs/PRP/bill-splitting.md §7)
-- CHECK ที่ migration 004 ตั้งไว้รับแค่ 4 ค่า ถ้าไม่ขยายก่อน insert จะไม่ผ่าน
ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_action_type_check;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_action_type_check
  CHECK (action_type IN (
    'create_game', 'edit_game', 'cancel_game', 'close_game',
    'create_bill', 'cancel_bill'
  ));

-- คำขอที่รอผู้ใช้กดยืนยัน ใช้กับ Create Wizard และการ์ดยืนยันทุกแบบ (spec §20)
CREATE TABLE pending_actions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_group_id  TEXT NOT NULL,
  requested_by   BIGINT NOT NULL REFERENCES users(id),
  game_id        BIGINT REFERENCES games(id),
  action_type    TEXT NOT NULL
                 CHECK (action_type IN ('create_game', 'edit_game', 'cancel_game', 'close_game')),
  payload        JSONB NOT NULL DEFAULT '{}',
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_actions_group ON pending_actions (line_group_id, expires_at);

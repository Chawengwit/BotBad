-- บริบทการคุยกับ LLM แยกตามกลุ่มและผู้ใช้ อายุสั้น (spec §20, LLM Design §10)
CREATE TABLE conversation_sessions (
  id             BIGSERIAL PRIMARY KEY,
  line_group_id  TEXT NOT NULL,
  line_user_id   TEXT NOT NULL,
  messages       JSONB NOT NULL DEFAULT '[]',
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_group_id, line_user_id)
);

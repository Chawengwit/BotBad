-- ผู้ใช้ LINE ที่เคยโต้ตอบกับบอท (spec §20)
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  line_user_id  TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

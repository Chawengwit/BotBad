-- รอบตีของแต่ละ LINE Group (spec §7, §20)
CREATE TABLE games (
  id                BIGSERIAL PRIMARY KEY,
  line_group_id     TEXT NOT NULL,
  created_by        BIGINT NOT NULL REFERENCES users(id),
  play_date         DATE NOT NULL,
  start_time        TIME NOT NULL,
  duration_minutes  INT NOT NULL CHECK (duration_minutes > 0 AND duration_minutes % 60 = 0),
  court_count       INT NOT NULL CHECK (court_count BETWEEN 1 AND 4),
  max_players       INT NOT NULL CHECK (max_players = court_count * 8),
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'cancelled', 'completed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 1 กลุ่มมีรอบที่ยังเปิดอยู่ได้ครั้งละ 1 รอบเท่านั้น
CREATE UNIQUE INDEX uq_games_one_open_per_group
  ON games (line_group_id)
  WHERE status = 'open';

CREATE INDEX idx_games_group_status ON games (line_group_id, status);

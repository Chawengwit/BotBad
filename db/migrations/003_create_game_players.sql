-- รายชื่อผู้เล่นในแต่ละรอบ (spec §20)
CREATE TABLE game_players (
  id          BIGSERIAL PRIMARY KEY,
  game_id     BIGINT NOT NULL REFERENCES games(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'joined'
              CHECK (status IN ('joined', 'cancelled')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_id, user_id)
);

CREATE INDEX idx_game_players_game_status ON game_players (game_id, status);

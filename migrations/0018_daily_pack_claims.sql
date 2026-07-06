CREATE TABLE daily_pack_claims (
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  claim_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, claim_date)
);

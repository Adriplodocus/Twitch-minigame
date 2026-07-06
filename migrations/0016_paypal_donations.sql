ALTER TABLE pack_grant_config ADD COLUMN paypal_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE pack_grant_config ADD COLUMN paypal_quantity INTEGER NOT NULL DEFAULT 1;

-- SQLite can't ALTER a CHECK constraint in place, so the packs table is rebuilt
-- with 'paypal'/'paypal_manual' added to the allowed source values (same
-- rebuild pattern as migrations/0013_expand_pack_source.sql).
PRAGMA defer_foreign_keys = TRUE;

CREATE TABLE packs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  source TEXT NOT NULL DEFAULT 'reward'
    CHECK (source IN ('reward', 'admin', 'bits', 'sub', 'gift_sub', 'paypal', 'paypal_manual')),
  tier TEXT NOT NULL DEFAULT 'gratis' CHECK (tier IN ('gratis', 'apoyo')),
  broadcast_at TEXT,
  granted_by TEXT,
  is_test INTEGER NOT NULL DEFAULT 0
);

INSERT INTO packs_new (id, user_id, opened_at, created_at, source, tier, broadcast_at, granted_by, is_test)
SELECT id, user_id, opened_at, created_at, source, tier, broadcast_at, granted_by, is_test FROM packs;

DROP TABLE packs;
ALTER TABLE packs_new RENAME TO packs;

CREATE INDEX idx_packs_user ON packs(user_id);

CREATE TABLE paypal_donations (
  txn_id TEXT PRIMARY KEY,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  note_raw TEXT,
  matched_username TEXT,
  matched_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('granted', 'unmatched', 'ignored')),
  packs_granted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);

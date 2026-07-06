ALTER TABLE pack_grant_config ADD COLUMN paypal_threshold INTEGER NOT NULL DEFAULT 2;
ALTER TABLE pack_grant_config ADD COLUMN paypal_quantity INTEGER NOT NULL DEFAULT 1;

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

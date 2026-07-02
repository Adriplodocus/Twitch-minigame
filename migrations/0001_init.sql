CREATE TABLE users (
  twitch_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rarity TEXT NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
  image_path TEXT NOT NULL
);

CREATE TABLE user_cards (
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(twitch_id),
  opened_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_packs_user ON packs(user_id);

CREATE TABLE pack_cards (
  pack_id INTEGER NOT NULL REFERENCES packs(id),
  card_id TEXT NOT NULL REFERENCES cards(id)
);

CREATE TABLE trade_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL REFERENCES users(twitch_id),
  to_user TEXT NOT NULL REFERENCES users(twitch_id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_trade_offers_to_user ON trade_offers(to_user);
CREATE INDEX idx_trade_offers_from_user ON trade_offers(from_user);

CREATE TABLE trade_items (
  offer_id INTEGER NOT NULL REFERENCES trade_offers(id),
  side TEXT NOT NULL CHECK (side IN ('from', 'to')),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE broadcaster_credentials (
  twitch_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

ALTER TABLE user_cards ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;

CREATE TABLE marketplace_offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_id TEXT NOT NULL REFERENCES users(twitch_id),
  demand_card_id TEXT NOT NULL REFERENCES cards(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'accepted')),
  acceptor_id TEXT REFERENCES users(twitch_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT
);
CREATE INDEX idx_marketplace_offers_creator ON marketplace_offers(creator_id);
CREATE INDEX idx_marketplace_offers_status ON marketplace_offers(status, created_at DESC);

CREATE TABLE marketplace_offer_items (
  offer_id INTEGER NOT NULL REFERENCES marketplace_offers(id),
  card_id TEXT NOT NULL REFERENCES cards(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

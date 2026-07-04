CREATE TABLE pack_grant_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  reward_quantity INTEGER NOT NULL DEFAULT 1,
  bits_threshold INTEGER NOT NULL DEFAULT 200,
  bits_quantity INTEGER NOT NULL DEFAULT 1,
  sub_quantity INTEGER NOT NULL DEFAULT 1,
  gift_sub_multiplier INTEGER NOT NULL DEFAULT 1
);

INSERT INTO pack_grant_config (id) VALUES (1);

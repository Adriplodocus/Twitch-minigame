ALTER TABLE packs ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

INSERT INTO users (twitch_id, username, avatar_url) VALUES ('__test__', 'Prueba', NULL);

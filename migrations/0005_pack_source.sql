ALTER TABLE packs ADD COLUMN source TEXT NOT NULL DEFAULT 'reward'
  CHECK (source IN ('reward', 'admin'));

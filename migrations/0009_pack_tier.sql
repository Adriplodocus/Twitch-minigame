ALTER TABLE packs ADD COLUMN tier TEXT NOT NULL DEFAULT 'gratis'
  CHECK (tier IN ('gratis', 'apoyo'));

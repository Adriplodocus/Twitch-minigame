ALTER TABLE cards ADD COLUMN category TEXT NOT NULL DEFAULT 'normal'
  CHECK (category IN ('normal', 'inicial', 'mega', 'gmax'));

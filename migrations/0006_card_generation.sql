ALTER TABLE cards ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

UPDATE cards SET generation = CASE
  WHEN category = 'mega' THEN 6
  WHEN category = 'gmax' THEN 8
  WHEN name LIKE '%Alola%' THEN 7
  WHEN name LIKE '%Galar%' THEN 8
  WHEN name LIKE '%Hisui%' THEN 8
  WHEN name LIKE '%Paldea%' THEN 9
  ELSE CASE
    WHEN sort_order / 1000000 BETWEEN 1 AND 151 THEN 1
    WHEN sort_order / 1000000 BETWEEN 152 AND 251 THEN 2
    WHEN sort_order / 1000000 BETWEEN 252 AND 386 THEN 3
    WHEN sort_order / 1000000 BETWEEN 387 AND 493 THEN 4
    WHEN sort_order / 1000000 BETWEEN 494 AND 649 THEN 5
    WHEN sort_order / 1000000 BETWEEN 650 AND 721 THEN 6
    WHEN sort_order / 1000000 BETWEEN 722 AND 809 THEN 7
    WHEN sort_order / 1000000 BETWEEN 810 AND 905 THEN 8
    ELSE 9
  END
END;

CREATE INDEX idx_cards_generation ON cards(generation);

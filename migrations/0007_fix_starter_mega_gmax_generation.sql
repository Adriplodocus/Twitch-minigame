-- 0006 set generation from `category`, but `category` collapses to 'inicial' (not 'mega'/'gmax')
-- for a starter species' Mega/Gmax forms (e.g. "Charizard Mega X", "Venusaur Gmax") — that
-- precedence is intentional for pack drop-rate weighting, but it meant 0006's
-- `WHEN category = 'mega' THEN 6` / `WHEN category = 'gmax' THEN 8` never fired for those cards,
-- leaving them in their base species' generation instead of the Mega/Gmax introduction generation.
-- Recompute using the same name patterns computeCategory itself uses to detect Mega/Gmax,
-- independent of the stored category value.

UPDATE cards SET generation = 6
WHERE (name LIKE '% Mega %' OR name LIKE '% Mega') AND generation <> 6;

UPDATE cards SET generation = 8
WHERE name LIKE '%Gmax%' AND generation <> 8;

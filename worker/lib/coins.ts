import type { Rarity } from "../types";

export const DISCARD_VALUE: Record<Rarity, number> = {
  common: 5,
  rare: 15,
  epic: 40,
  legendary: 150,
};

export const DISCARD_VALUE_SHINY: Record<Rarity, number> = {
  common: 40,
  rare: 120,
  epic: 320,
  legendary: 1200,
};

export const SHINY_CONVERSION_COST: Record<Rarity, number> = {
  common: 150,
  rare: 400,
  epic: 1000,
  legendary: 3500,
};

export const PACK_BOOST_COST = 150;

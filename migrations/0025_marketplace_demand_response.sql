ALTER TABLE trade_offers ADD COLUMN marketplace_demand_id INTEGER;
CREATE INDEX idx_trade_offers_marketplace_demand ON trade_offers(marketplace_demand_id);

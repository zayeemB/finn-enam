-- Seed once under the migration lock; preserve portfolios, preferences and memberships.
INSERT INTO portfolios(id,name) VALUES ('00000000-0000-4000-8000-000000000001','Demo portfolio') ON CONFLICT DO NOTHING;
INSERT INTO portfolio_settings(portfolio_id,digest_anchor_at,updated_at) VALUES ('00000000-0000-4000-8000-000000000001',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO monitoring_state(portfolio_id) VALUES ('00000000-0000-4000-8000-000000000001') ON CONFLICT DO NOTHING;
INSERT INTO alert_rules(id,portfolio_id,rule_type,settings) VALUES
(gen_random_uuid(),'00000000-0000-4000-8000-000000000001','price_move','{"percent":5}'),
(gen_random_uuid(),'00000000-0000-4000-8000-000000000001','volume_spike','{"multiple":2,"sessions":20}'),
(gen_random_uuid(),'00000000-0000-4000-8000-000000000001','announcement','{"categories":["results","M&A","management_change","litigation","credit_rating","fund_raise"]}') ON CONFLICT DO NOTHING;

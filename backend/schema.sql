-- Additive, isolated Node catalogue. No disclosure_versions and no download jobs.
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY, nse_symbol TEXT UNIQUE NOT NULL, bse_code TEXT UNIQUE, name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS portfolios (
  id UUID PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS portfolio_companies (
  portfolio_id UUID REFERENCES portfolios(id), company_id UUID REFERENCES companies(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(portfolio_id,company_id)
);
CREATE TABLE IF NOT EXISTS collection_state (
  company_id UUID REFERENCES companies(id), source TEXT NOT NULL,
  last_successful_fetch_at TIMESTAMPTZ, last_attempt_at TIMESTAMPTZ, last_error TEXT,
  lease_token UUID, lease_expires_at TIMESTAMPTZ,
  PRIMARY KEY(company_id,source)
);
CREATE TABLE IF NOT EXISTS disclosures (
  id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id),
  source TEXT NOT NULL, source_key TEXT NOT NULL, title TEXT NOT NULL, source_url TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL, first_seen_at TIMESTAMPTZ NOT NULL,
  raw_metadata JSONB NOT NULL, metadata_hash TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(company_id,source,source_key)
);
CREATE INDEX IF NOT EXISTS disclosures_window ON disclosures(published_at,company_id);
CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY, disclosure_id UUID NOT NULL REFERENCES disclosures(id), source_url TEXT NOT NULL,
  filename TEXT, media_type TEXT, content_hash TEXT, byte_size BIGINT,
  temporary_file_path TEXT, storage_backend TEXT,
  download_status TEXT NOT NULL DEFAULT 'pending' CHECK(download_status IN ('pending','downloaded','failed','unsupported')),
  download_attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TIMESTAMPTZ, download_error TEXT,
  downloaded_at TIMESTAMPTZ, expires_at TIMESTAMPTZ,
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK(extraction_status IN ('pending','complete','partial','failed','unsupported')),
  extraction_error TEXT, etag TEXT, last_modified TEXT, checked_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ NOT NULL, is_current BOOLEAN NOT NULL DEFAULT true,
  lease_token UUID, lease_expires_at TIMESTAMPTZ,
  UNIQUE(disclosure_id,source_url)
);
CREATE INDEX IF NOT EXISTS assets_retries ON assets(next_retry_at,checked_at);
CREATE TABLE IF NOT EXISTS content_blocks (
  id UUID PRIMARY KEY, asset_id UUID NOT NULL REFERENCES assets(id), asset_content_hash TEXT NOT NULL,
  block_type TEXT NOT NULL, location JSONB NOT NULL, sequence INTEGER NOT NULL, content JSONB,
  temporary_image_path TEXT, extraction_method TEXT, status TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS processing_jobs (
  id UUID PRIMARY KEY, job_type TEXT NOT NULL CHECK(job_type IN ('extract','analyse')),
  disclosure_id UUID NOT NULL REFERENCES disclosures(id), asset_id UUID REFERENCES assets(id),
  input_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','completed','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
  model TEXT, processor_version TEXT, prompt_version TEXT, output JSONB, error TEXT,
  created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  CHECK((job_type='extract' AND asset_id IS NOT NULL) OR (job_type='analyse' AND asset_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS processing_job_input ON processing_jobs(
  job_type,disclosure_id,coalesce(asset_id,'00000000-0000-0000-0000-000000000000'::uuid),input_hash
);
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id), category TEXT NOT NULL,
  title TEXT NOT NULL, summary TEXT NOT NULL, details JSONB NOT NULL, importance TEXT NOT NULL,
  importance_reason TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS event_evidence (
  id UUID PRIMARY KEY, event_id UUID NOT NULL REFERENCES events(id), event_version INTEGER NOT NULL,
  disclosure_id UUID REFERENCES disclosures(id), asset_id UUID REFERENCES assets(id),
  content_block_id UUID REFERENCES content_blocks(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL, location JSONB, evidence_snapshot JSONB NOT NULL,
  retained_image_path TEXT, relationship TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id), metric TEXT NOT NULL,
  value NUMERIC NOT NULL, unit TEXT NOT NULL, period_start DATE NOT NULL, period_end DATE NOT NULL,
  frequency TEXT NOT NULL, scope TEXT NOT NULL, source_url TEXT NOT NULL,
  disclosure_id UUID REFERENCES disclosures(id), asset_id UUID REFERENCES assets(id),
  content_block_id UUID REFERENCES content_blocks(id) ON DELETE SET NULL, evidence_snapshot JSONB NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, is_current BOOLEAN NOT NULL DEFAULT true, collected_at TIMESTAMPTZ NOT NULL,
  UNIQUE(company_id,metric,period_start,period_end,frequency,scope,unit,revision)
);
CREATE UNIQUE INDEX IF NOT EXISTS current_observation ON observations(company_id,metric,period_start,period_end,frequency,scope,unit) WHERE is_current;
CREATE TABLE IF NOT EXISTS alert_rules (
  id UUID PRIMARY KEY, portfolio_id UUID NOT NULL REFERENCES portfolios(id), rule_type TEXT NOT NULL,
  settings JSONB NOT NULL, enabled BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id), portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  rule_id UUID REFERENCES alert_rules(id), event_id UUID REFERENCES events(id), event_version INTEGER,
  market_session DATE, message TEXT NOT NULL, trigger_details JSONB NOT NULL,
  dedup_key TEXT UNIQUE NOT NULL, delivery_status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL, sent_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS research_jobs (
  id UUID PRIMARY KEY, company_id UUID NOT NULL REFERENCES companies(id), question TEXT NOT NULL,
  status TEXT NOT NULL, progress TEXT, result JSONB, data_as_of JSONB,
  created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, error TEXT
);
CREATE TABLE IF NOT EXISTS research_evidence (
  id UUID PRIMARY KEY, research_job_id UUID NOT NULL REFERENCES research_jobs(id),
  disclosure_id UUID REFERENCES disclosures(id), asset_id UUID REFERENCES assets(id),
  content_block_id UUID REFERENCES content_blocks(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL, location JSONB, evidence_snapshot JSONB NOT NULL, retained_image_path TEXT
);

-- Additive extraction-worker migration; safe for catalogues created by the collector.
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS extraction_metadata JSONB;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS extraction_processor_version TEXT;
ALTER TABLE content_blocks ADD COLUMN IF NOT EXISTS processor_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS extracted_page ON content_blocks(asset_id,asset_content_hash,processor_version,sequence);
CREATE INDEX IF NOT EXISTS jobs_ready ON processing_jobs(job_type,status,next_attempt_at);

CREATE TABLE IF NOT EXISTS analysis_batches (
  id UUID PRIMARY KEY, job_id UUID NOT NULL REFERENCES processing_jobs(id),
  cache_key TEXT NOT NULL, input_hash TEXT NOT NULL, stage TEXT NOT NULL,
  model TEXT NOT NULL, prompt_version TEXT NOT NULL, output JSONB NOT NULL,
  usage JSONB, created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(job_id,cache_key)
);
CREATE TABLE IF NOT EXISTS analysis_event_links (
  job_id UUID NOT NULL REFERENCES processing_jobs(id), development_key TEXT NOT NULL,
  event_id UUID NOT NULL REFERENCES events(id), event_version INTEGER NOT NULL,
  relationship TEXT NOT NULL, presentation JSONB NOT NULL,
  PRIMARY KEY(job_id,development_key)
);
CREATE TABLE IF NOT EXISTS provider_backoff (
  provider TEXT PRIMARY KEY, retry_after TIMESTAMPTZ NOT NULL, reason TEXT NOT NULL
);
ALTER TABLE observations ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ;
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS error_kind TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_rule_type ON alert_rules(portfolio_id,rule_type);
INSERT INTO alert_rules(id,portfolio_id,rule_type,settings)
SELECT gen_random_uuid(),p.id,d.rule_type,d.settings::jsonb FROM portfolios p
CROSS JOIN (VALUES
  ('price_move','{"percent":5}'),
  ('volume_spike','{"multiple":2,"sessions":20}'),
  ('announcement','{"categories":["results","M&A","management_change","litigation","credit_rating","fund_raise"]}')
) AS d(rule_type,settings)
ON CONFLICT(portfolio_id,rule_type) DO NOTHING;

CREATE TABLE IF NOT EXISTS portfolio_settings (
  portfolio_id UUID PRIMARY KEY REFERENCES portfolios(id), monitoring_enabled BOOLEAN NOT NULL DEFAULT true,
  monitoring_minutes INTEGER NOT NULL DEFAULT 15 CHECK(monitoring_minutes BETWEEN 1 AND 1440),
  digest_hours INTEGER NOT NULL DEFAULT 24 CHECK(digest_hours BETWEEN 1 AND 168),
  digest_anchor_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS monitoring_state (
  portfolio_id UUID PRIMARY KEY REFERENCES portfolios(id), phase INTEGER NOT NULL DEFAULT 0,
  lease_token UUID, lease_expires_at TIMESTAMPTZ, cycle_started_at TIMESTAMPTZ,
  last_collection_at TIMESTAMPTZ, refresh_requested_at TIMESTAMPTZ,
  last_started_at TIMESTAMPTZ,last_finished_at TIMESTAMPTZ,last_error TEXT,last_result JSONB
);
CREATE TABLE IF NOT EXISTS digest_runs (
  id UUID PRIMARY KEY,portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  window_start TIMESTAMPTZ NOT NULL,window_end TIMESTAMPTZ NOT NULL,
  result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(portfolio_id,window_start,window_end)
);
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY,portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  kind TEXT NOT NULL CHECK(kind IN ('alert','digest')),reference_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,read_at TIMESTAMPTZ,
  UNIQUE(portfolio_id,kind,reference_id)
);
ALTER TABLE disclosures ADD COLUMN IF NOT EXISTS collection_mode TEXT NOT NULL DEFAULT 'monitoring';
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS error_kind TEXT;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}';
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS last_claimed_at TIMESTAMPTZ;
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS recheck_page_ids UUID[];
ALTER TABLE research_jobs ADD COLUMN IF NOT EXISTS research_state JSONB NOT NULL DEFAULT '{}';
-- Older workers could exhaust retries asking the model to echo database UUIDs.
UPDATE research_jobs SET status='waiting',progress='Resuming saved page reviews',error=NULL,error_kind=NULL,
  next_attempt_at=NULL,attempts=0 WHERE status='failed' AND (error='Research page coverage mismatch' OR
    (error_kind='processing' AND error IN ('Research quote is not in its source page','Research fact introduced an uncited number','Research citation outside supplied pages')));
UPDATE research_jobs SET status='waiting' WHERE status='failed' AND next_attempt_at IS NOT NULL
  AND (error_kind='provider_transient' OR (error_kind='processing' AND attempts<5));
CREATE TABLE IF NOT EXISTS research_documents (
  id UUID PRIMARY KEY,research_job_id UUID NOT NULL REFERENCES research_jobs(id),
  disclosure_id UUID REFERENCES disclosures(id),kind TEXT NOT NULL CHECK(kind IN ('annual_report','transcript')),
  title TEXT NOT NULL,source_url TEXT NOT NULL,discovery_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',error TEXT,UNIQUE(research_job_id,source_url)
);
CREATE TABLE IF NOT EXISTS research_batches (
  job_id UUID NOT NULL REFERENCES research_jobs(id),cache_key TEXT NOT NULL,
  model TEXT NOT NULL,output JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(job_id,cache_key)
);
ALTER TABLE research_documents ADD COLUMN IF NOT EXISTS index_metadata JSONB NOT NULL DEFAULT '{}';

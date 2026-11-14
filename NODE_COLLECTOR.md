# Node.js raw monitoring collector

This replaces the keyword-based interpretation path for new development. The collector preserves raw inputs; it does not summarise, classify, judge importance, call an LLM, or send alerts. Extraction and analysis are separate stages.

The backend uses a PostgreSQL catalogue. Previously collected data is preserved under `data/`; legacy SQLite records are not automatically imported.

## Start locally

Requires Node.js 22.13+ and npm:

```bash
npm ci
npm run portfolio -- RELIANCE TCS HDFCBANK
npm run collect
npm run extract
npm run inspect
npm test
```

`portfolio` with symbols replaces the monitored list; without symbols it lists it. Removing portfolio membership does not delete company data. The collector processes at most five companies and ten downloads per invocation by default. Subsequent invocations choose the least recently attempted companies, so a larger portfolio is covered across bounded calls.

Without credentials, local development uses embedded PostgreSQL (PGlite) in `data/node/postgres/` and original asset files in `data/node/assets/`. This uses the same PostgreSQL schema as the hosted path, without requiring a local database server. Run local PGlite commands sequentially; use managed PostgreSQL for multiple backend processes.

Copy `.env.example` to `.env` to configure limits or cloud services. All npm commands load `.env` if present. Both are ignored by Git except the safe `.env.example` template. Limits include bootstrap hours, overlap, company/download counts, and the invocation's time budget.

## Collection flow

1. Read the saved portfolio and acquire a short-lived company/source lease. Overlapping invocations cannot advance the same source checkpoint concurrently.
2. Query NSE from the last successful fetch minus the overlap through the invocation's start time. First checks use the preceding 24 hours by default. All source metadata is retained, including unfamiliar fields and low-priority disclosures.
3. Atomically store disclosures and their asset links, then advance the checkpoint. A failed database transaction rolls back both; a failed source request leaves the previous successful checkpoint intact.
4. The collector downloads assets itself. There is no download processing-job type. Failures have attempts, retry time, and error fields on the asset, independently of the discovery checkpoint. Some pending downloads are resumed before new discovery so unavailable feeds cannot indefinitely starve retries.
5. Save original file bytes under a content-derived storage key and enqueue an `extract` job. Tables, charts, scanned pages, and images are preserved in those original bytes. No content is discarded by keyword selection.
6. Structured daily price/volume data is written directly into observations, preserving changed values as revisions. Price history is seeded once and fetched with an overlapping week on later EOD checks. Corporate actions accompany its source evidence. No alert decisions occur in collection.

Only NSE announcements and Yahoo daily market data are connected in this version. It discovers annual reports/transcripts when published through the NSE feed; it does not crawl every company's full report catalogue, BSE-only feeds, or news. The schema supports multiple assets per disclosure, though the current NSE adapter exposes its supplied primary attachment.

## Repeated and changed files

- Publisher ID identifies a disclosure. When absent, the parser derives a key from the attachment reference, or publication details if no unique document link exists.
- Repeated metadata does not create another disclosure or asset.
- Recently observed URLs are revalidated after 15 minutes by default, even if metadata is unchanged. Conditional requests use ETag/Last-Modified when available; otherwise bytes are fetched and hashed again. A missing local file forces a full download.
- `npm run collect -- --revalidate` also considers older saved active URLs for revalidation, subject to the same interval and invocation limits. Normal monitoring only revalidates documents seen again in the overlapping feed; it cannot detect changes to an old URL that never reappears unless revalidation is requested.
- Changed bytes invalidate pending/running older extraction and analysis jobs and queue the current content hash. Input-hash checking is also exposed for the future worker before committing results.
- Assets removed/replaced by a newer source response remain referenced for historical evidence but are marked non-current; their outstanding jobs are superseded.
- No separate disclosure-version table is used. The collector updates current raw inputs. Previously generated findings must retain their own evidence snapshots.

## Database schema

The authoritative schema is [`backend/schema.sql`](backend/schema.sql).

| Area | Tables |
|---|---|
| Company directory and portfolios | `companies`, `portfolios`, `portfolio_companies` |
| Discovery checkpoint | `collection_state` |
| Raw inputs and downloaded files | `disclosures`, `assets` |
| Full page/table/image extraction | `content_blocks` |
| Extraction/analysis work | `processing_jobs` (`extract` or `analyse` only) |
| Interpreted developments and citations | `events`, `event_evidence` |
| Quantities and revisions | `observations` |
| Alert settings/history | `alert_rules`, `alerts` |
| On-demand research | `research_jobs`, `research_evidence` |

Compared with the discussed schema, assets also have `last_seen_at`, `checked_at`, `is_current`, conditional-request validators, storage-backend information, and expiring leases. These allow safe retries and same-URL revalidation without a separate download worker. Checkpoints likewise have expiring leases.

`temporary_file_path` stores a storage key, not necessarily an operating-system path. `storage_backend` determines how a worker reads it. Content hashes permit identical files to share physical storage while each disclosure keeps its source association.

## Extraction and the next analysis worker

The extraction and LLM analysis workers are implemented. See [EXTRACTION_WORKER.md](EXTRACTION_WORKER.md) and [ANALYSIS_WORKER.md](ANALYSIS_WORKER.md). Live model calls require a configured Gemini key; the collector itself still performs no interpretation.

- Extraction claims an `extract` job, checks the asset is current and its hash matches `input_hash`, reads its original bytes through the file-store adapter, and writes `content_blocks`. Each block carries its originating asset hash. A page block may include complete text and a rendered-page reference; table/image blocks preserve structure and visual context.
- Record complete, partial, failed, or unsupported coverage explicitly. Do not mark scanned pages complete just because text extraction returned nothing.
- After all pages are prepared, the worker marks the asset complete and calls `queueAnalysis` in the same transaction. Scanned pages retain their full images for vision; complete preparation does not claim OCR or semantic analysis. Unsupported file types are explicitly represented in the analysis input. Partial/incomplete page preparation blocks full analysis. Metadata-only disclosures are queued directly by the collector.
- Analysis reads metadata and all current asset content, checks `jobInputIsCurrent` before applying output, and validates grounded results into events, evidence snapshots, and observations. Unsupported assets must be explicitly accounted for; failed/incomplete extraction does not silently produce a complete analysis.
- Workers must use expiring job leases and check ownership/current input inside their commit transaction. The helper is a current-input check, not a substitute for job ownership.
- Retain supporting source title/URL/date, passages, cells, and visual crops with findings before removing working content.

The output tables are created now but are not populated with rule-based guesses. No LLM credentials are required by the collector.

## Temporary storage and retention

Unprocessed/failed assets are not deleted. Their `expires_at` starts empty. After successful extraction **and analysis**, the future analysis/cleanup stage can set a 24-hour grace period and remove working files/blocks only when references permit. Previously generated findings retain evidence snapshots independently.

Automatic retention cleanup is not implemented in this collector milestone. Current files remain until that processing/cleanup stage is built; calling them temporary does not make them self-deleting. Old shared or changed-file storage objects must be removed only when no active job/asset/evidence needs them. A 30-day disclosure-metadata window remains a proposed default, conditional on dependencies.

## Vercel deployment preparation

`api/collect.js` is a bounded Node function. It accepts GET (scheduler) or POST (manual trigger) with `Authorization: Bearer <CRON_SECRET>`. It rejects missing/incorrect secrets and never caches results. Collection limits come from environment variables; requests cannot select arbitrary URLs or modify the portfolio. Configure portfolio membership through the CLI using the hosted database connection.

Set:

- `DATABASE_URL`: managed PostgreSQL connection string, with provider-required TLS.
- `BLOB_READ_WRITE_TOKEN`: a **private** Vercel Blob store, used for temporary files shared between invocations and workers.
- `CRON_SECRET`: a random scheduler credential.

On Vercel, missing database/blob configuration is an error; it never falls back to ephemeral local storage. Hosted schema creation uses the same SQL as local development. For a larger deployment, run schema migrations as a deployment step rather than on request startup.

The route is configured for a 60-second maximum, with a 45-second collection budget by default. It checks the budget before starting further network operations; an abrupt function termination is recovered through checkpoints, asset/job states, and expiring leases. This is not an indefinitely running process. [Vercel function duration](https://vercel.com/docs/functions/configuring-functions/duration)

No scheduler or cloud services are provisioned by this change. Hobby cron is daily; use a suitable plan or external authenticated scheduler for frequent checks. For 50 companies, schedule enough bounded invocations to cover the portfolio at the intended frequency. [Vercel cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing)

Private Blob and managed PostgreSQL adapters are implemented, but require real credentials for deployment integration testing. Local database/file behaviour and authenticated endpoint checks are tested without those services.

## Tests

`npm test` covers full raw-metadata/byte preservation, duplicate source IDs, same-URL changed bytes, invalidated jobs, failed-download retries after checkpoint advancement, transaction rollback, discovery overlap, metadata-only analysis, conditional requests, missing-file recovery, source leases, replaced assets, numerical revisions, source identity, unfinished sessions, and HTTP authentication.

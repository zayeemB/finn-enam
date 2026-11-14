# LLM analysis, alerts and digests

The Node backend now has three independent stages:

```text
Collector → original disclosures/assets → extraction jobs
Extraction worker → full text and rendered pages → analysis jobs
Analysis worker → grounded findings/evidence/observations → alert candidates + digest data
```

The analysis worker uses `gemini-3.1-flash-lite` to read page text/images, then `gemini-3.6-flash` for intermediate combination, event matching and final interpretation. Gemini 3.5 Flash is deprecated and automatically routes to 3.6, so the project names 3.6 explicitly. Gemini 3.8 is no longer a default or fallback. It never grants the model database access, tools, notification delivery, or open-ended web research. Numerical comparisons and rule evaluation are ordinary code.

## Setup and commands

Install dependencies with `npm ci`. Set `GEMINI_API_KEY` in your ignored local `.env` or deployment secrets. Do not paste secrets into a chat or commit them. The collector and extraction worker still need no model key.

```bash
npm run analyse
npm run inspect
npm run digest -- --hours 36
npm run digest -- --from 2026-11-10T00:00:00+05:30 --to 2026-11-11T12:00:00+05:30
npm run alerts
npm run rules
npm run rules -- --price-percent 4 --volume-multiple 2.5 --volume-sessions 20
npm run rules -- --categories 'results,M&A,management_change,litigation'
npm run evaluate-alerts
```

Local commands (`npm run analyse` and `npm run analyse:groq`) now keep working until one eligible disclosure is completed, allowing up to 300 seconds per LLM request. They do not stop at the previous two-call or 270-second total budget. They exit if no work is eligible or an error prevents progress, preserving validated batches for a later attempt. Hosted calls remain bounded at 45 seconds total, 40 seconds per request and the configured call/job limits. Long documents can resume across hosted invocations without restarting. `--retry-failed` resets failed analysis jobs' retry counters, while retaining project-wide cooldown protection:

```bash
npm run analyse -- --retry-failed
```

`GEMINI_EXTRACTION_MODEL`, `GEMINI_REASONING_MODEL` and `ANALYSIS_*` options are documented in `.env.example`. Optional `GEMINI_EXTRACTION_FALLBACK_MODEL` and `GEMINI_REASONING_FALLBACK_MODEL` default to empty. The former global `GEMINI_MODEL`/`GEMINI_FALLBACK_MODEL` settings do not select the worker stages. Model changes affect pending work; completed disclosures are not automatically reanalysed merely because an environment variable changed. Page cache keys identify the extraction model; combine/final keys identify the reasoning model and their supplied findings. Already validated page batches from the same immutable input/prompt remain reusable across the transition and are validated again before use. Existing cached outputs are not deleted. Every batch records the actual producing model. Final output records the synthesis model, all used models and batch provenance.

## All-page multimodal analysis

1. Claim an analysis job with a short-lived ownership token. Confirm its source input hash is current.
2. Load disclosure metadata and every prepared page from every current supported asset. Check page counts/sequences. Unsupported assets remain explicit limitations.
3. Divide all pages into batches (two pages by default). Supply **full page text and full page images** for each batch. Text is never preselected by keywords. Large PNGs may be encoded as JPEG for the API's inline-request size; the retained source image is unchanged.
4. Ask Flash-Lite for broad structured findings, including routine information without filtering by importance: separate developments, category, concise summary, why it may matter, materiality reason, key facts, observations, management changes, and evidence. Each response must account for exactly the supplied page IDs.
5. Validate batch findings locally. If a new Flash-Lite response fails validation, ask the reasoning model to independently reread the same original pages and validate that replacement. Invalid output is never cached or published. This extra request counts toward hosted budgets; it is not proof that an accepted output is semantically correct. Cache validated batch findings in PostgreSQL. When necessary, combine them hierarchically, without dropping page coverage. Oversized inputs fail explicitly rather than silently truncating.
6. Synthesise the validated findings and compare with up to 50 recent company events from a 90-day lookback. This is interpretation context, not authority to invent facts. Synthesis may only reuse existing validated citations and numerical observations.
7. In one transaction, verify ownership/current input again, save events and evidence snapshots, update observations, prepare alerts, and complete the job.

Metadata-only disclosures can be analysed directly. Scanned pages are supplied as images for the vision-capable model. The extraction stage's `complete` means all pages were prepared; the analysis stage is responsible for understanding them.

The prompt treats documents, images and prior-event descriptions as untrusted source data. It forbids following embedded instructions, making external requests, using company knowledge from memory, guessing figures or table columns, and asserting stock-price causality.

## Validation and evidence

Structured output is validated with Zod. Code checks:

- Exact page coverage and valid page/block references.
- Text and metadata quotations actually occur in their cited inputs after whitespace/Unicode normalisation.
- Visual citations refer to provided page images; cited images must still exist before commit.
- Facts and financial observations reference valid evidence indexes.
- Text-only numerical values occur in their cited evidence; dates are valid and increasing.
- Prior-event matches belong to the supplied company context and category. Quarterly result matches must agree on the latest reporting period, including when tables contain overlapping comparison columns.
- Synthesis does not introduce fresh citations or numerical observations.

These are structural/provenance checks, **not proof of semantic correctness**. Visual table transcription, column meaning, event matching, scope, and materiality still require model judgement. Real-model quality needs live evaluation on representative filings. Live checks and their limits are recorded in `GEMINI_DEBUGGING.md`. The provider receives a simplified structural JSON grammar to avoid its schema-complexity rejection. Length/range/pattern checks still run locally against the full schema before results are accepted.

Every finding retains its source URL/title/date, supporting text or table transcription, page reference, and visual-page storage reference where relevant. These snapshots survive deletion of working content blocks. Full-page evidence images currently serve as retained visual evidence; smaller crops can be introduced later. Working assets are not deleted until downstream success and reference-aware cleanup exist.

## Repetition and corrections

The model distinguishes new, repeated, update and correction relationships. Code validates matched company/event IDs, prevents an exact factual repeat from advancing a version, and recognises changed comparable figures. Each source is still linked to the event even when it repeats it.

Events preserve a version number. Evidence and per-disclosure presentations retain the version they supported. Corrections can produce a new alert version; a repeated filing cannot produce another delivery of the same event version. Late processing of an older disclosure cannot overwrite newer financial observations or advance an event from newer published information.

Semantic matching is bounded by the retrieved context and remains fallible; it is separate from exact source/file deduplication and from alert delivery deduplication. Uncertain matches should remain separate developments. There is no claim that all paraphrased duplicates are perfectly detected.

## Financial presentation

The model extracts reported numbers with their units, reporting periods and accounting scope. Code saves observation revisions, preserving the latest published value as current. It computes quarterly Revenue, EBITDA, PBT and PAT cards with QoQ/YoY comparisons only where matching prior periods, scopes and **identical units** are available. Different currency scales are currently marked unavailable rather than converted implicitly. Zero/negative comparison bases produce a labelled unavailable percentage, not misleading growth.

Incoming executive background is extracted only when present in the filing. Missing biography is null. Separate professional-background enrichment is not implemented; research workflows remain separate and must use their prescribed primary sources.

## Alerts

Default portfolio rules are added without overwriting existing settings:

- EOD absolute close move greater than 5%.
- EOD volume greater than twice the preceding 20 trading sessions' average; the current session is excluded.
- High-importance announcements in selected material categories.

Market rules run after collection and can also run with `evaluate-alerts`; they need no model call. They require enough baseline data, suppress stale sessions older than four calendar days, and exclude split-affected price sessions/volume baselines to avoid misleading comparisons.

Announcement alerts are committed with the finding, using an idempotent portfolio/rule/event/version key. Market alerts use a portfolio/rule/company/session key. Candidates contain the company, message, trigger, relevant figures, evidence, and limitations.

`delivery_status=pending` and `sent_at=null` are intentional. No email, mobile notification, or other external delivery is performed. Changing announcement categories affects future event evaluation, not a bulk replay of every old event. Stored delivery history is not erased when thresholds change.

## Digests

Digests are read-only views over disclosures with publication timestamps in `[from,to)`. The default is 24 hours; hours and timezone-qualified timestamps are configurable.

- Every portfolio disclosure in the window has an entry, including routine, queued, failed and unsupported processing.
- High-priority developments sort first. Routine entries remain accessible and are listed for collapsed presentation.
- Related event/version presentations are grouped while individual source links and publication times remain available.
- Later corrections are visible in their own publication window. Historical presentations are retained separately from the latest event summary.
- No model calls or document downloads are made by digest requests.
- Each item exposes `analysis.available`, `analysed_at`, `is_current`, model provenance and saved source metadata. When a revised disclosure is pending, its previous result stays readable with an explicit stale-analysis notice.
- `saved_company_results` provides the latest saved completed disclosure analysis for each portfolio company with a result, even outside the selected window. Publication/analysis timestamps, current-input status and pending disclosure counts are explicit. This is saved company context, not an invented in-window event or a complete company research report.
- The included local frontend shows analysis timestamps and pending/stale notices. See `BACKEND_APP.md` for the cookie API and test UI.

The output is structured JSON rendered by the included frontend, rather than a finished narrative newsletter. It also includes alerts created during the window and a separate latest saved EOD close/volume snapshot. The snapshot is labelled by session/collection date and is current at request time; it is not presented as a historical as-of replay of market data.

## Retries and quota

Validated page/merge batches survive interruption, failure and later invocations. Expiring leases and current-input checks reject late results from stopped workers or changed documents. Missing derived images request regeneration by extraction; the analysis worker never downloads source files itself.

Rate limits, provider overload and network timeouts create durable per-model cooldowns and job backoff. Subsequent worker runs honour each cooldown before model requests. The worker tries the configured fallback when the primary has a transient failure or is cooling down, subject to the same invocation call/time limits. In bounded hosted mode, a failed primary attempt can consume the last call slot; the next invocation then uses the available fallback. Local completion mode does not impose a call-count cap. Both unavailable models leave the job pending for a later run. No fallback occurs for configuration errors or invalid findings. Legacy Gemini-wide cooldowns apply to the primary, allowing the newly configured fallback to run. Transient provider outages remain retryable even after five failures; processing/validation failures stop after five consecutive failures. Non-retryable configuration errors require a fix and explicit `--retry-failed`. Successful progress resets consecutive failures. Usage metadata is saved with each completed batch. Before every model attempt, the worker verifies ownership/current input and renews its job lease for at least the request timeout plus 60 seconds. This allows a five-minute response to be validated and saved without the old five-minute lease expiring during the call.

Run `npm run diagnose:gemini` for a synthetic, document-free connectivity/model check. See [GEMINI_DEBUGGING.md](GEMINI_DEBUGGING.md) for observed provider failures and recovery behaviour.

The adapter calls Google's Interactions API with structured JSON output, inline images, an explicitly configured primary and optional fallback, `store=false`, and no tools. Only the configured pair is attempted; there is no billing/account mutation. Stage fallback model variables are opt-in. The extraction and reasoning models are complementary stages, not interchangeable fallbacks. A reasoning-stage outage preserves extracted batches and leaves synthesis retryable. Legacy global/3.8 cooldowns do not block the new pair, while their own per-model cooldowns remain enforced. Free-tier eligibility and actual limits must be checked for the project; model availability does not prove the account is on the free tier. A project's billing tier and active quota still govern requests; the application cannot turn a paid project key into a free-only key. Do not assume continuous monitoring of 50 companies fits a free quota.

Official references: [extraction model](https://aistudio.google.com/docs/models/gemini-3.1-flash-lite), [reasoning model](https://aistudio.google.com/docs/models/gemini-3.6-flash), [structured output](https://aistudio.google.com/docs/structured-output), [image inputs](https://aistudio.google.com/docs/image-understanding), [active rate limits](https://aistudio.google.com/docs/rate-limits).

## Endpoints and schema additions

Protected routes: `/api/analyse` (GET/POST worker), `/api/digest` (GET), `/api/alerts` (GET). They reuse the backend bearer secret and disable caching. They are internal demo endpoints; browser clients must not be given the scheduler secret. No endpoints are deployed by these file changes.

New tables: `analysis_batches` for resumable model results/usage, `analysis_event_links` for source-specific presentations, and `provider_backoff` for shared cooldowns. Observations add `source_published_at`; default rule uniqueness/seeding is additive. The authoritative SQL remains `backend/schema.sql`.

Research, demo browser sessions and the local frontend were added subsequently; see `BACKEND_APP.md`. Reference-aware cleanup, external notification delivery and multi-user accounts remain future work. Existing source files and working content are retained safely.

## Verification

`npm test` runs isolated mocked model integration tests plus existing collection/extraction tests. It covers multimodal page coverage, durable batch reuse, hierarchical combination, invalid quotes/numbers, event repetitions/corrections, reporting-period guards, old-versus-new observations, evidence retention, lease/input invalidation, quota cooldowns, digest completeness, and EOD calculations. Mocked responses test the pipeline; they are never written into the real company-data catalogue.

## Groq alternative

The same worker also supports Groq’s `qwen/qwen3.8-27b` through JSON mode and full page images, retaining all local validation. Run `npm run diagnose:groq` for a synthetic check and `npm run analyse:groq` for an explicit Groq-only worker invocation. See [GROQ_SETUP.md](GROQ_SETUP.md) for key setup, provider selection, free-plan limits and live-test status. The existing Gemini configuration remains active until changed explicitly.

## Stage diagnostics

```bash
npm run diagnose:gemini -- --stage extraction
npm run diagnose:gemini -- --stage reasoning
```

The default diagnostic checks the reasoning model. Both commands use synthetic text only; success is a connectivity check, not a document-quality test. Existing five-minute local request timeouts and run-until-one-disclosure-completes behavior are preserved. Hosted limits remain bounded. The parser/render worker still uses code, not an LLM; Flash-Lite is used in the subsequent page-reading stage.

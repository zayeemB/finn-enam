# Backend for the demo frontend

Run `npm ci`, configure model keys in the ignored `.env`, then:

```bash
npm run dev
```

This serves the frontend and local API together at `http://127.0.0.1:3001/` and automatically runs monitoring/research worker ticks. Open that URL in a browser to test the app. Keep the process running for background updates. It binds to loopback, not the public network. Set `PORT` to change the port. Do not run another local process against the same PGlite directory; the server owns that local database. Stop the server before using database CLI commands, or use managed PostgreSQL for multiple processes.

The server prints a temporary demo access code at startup unless `DEMO_ACCESS_CODE` is configured (at least 12 characters). A deployed API requires a configured code. The browser exchanges it once for an opaque HttpOnly, SameSite=Strict cookie, valid for 12 hours. Only its hash is stored in the database. This is one demo portfolio, not a multi-user account system.

The included buildless frontend calls `/api/app` on the same origin, so no proxy or CORS setup is needed. A separate frontend can proxy `/api/app` through its own origin to this backend. For a separate frontend dev origin, set `APP_ORIGIN` to that exact origin and forward requests through the frontend server. No wildcard CORS is enabled. On deployment the API can live on the same origin as the frontend. Browser requests never carry Gemini keys, database credentials, blob tokens or `CRON_SECRET`.

## Browser API

Use `/api/app?resource=...`. Every mutation includes `X-Finn-Client: web`; JSON bodies use `Content-Type: application/json`. Send cookies (`credentials: 'same-origin'` through the frontend proxy). Unknown fields/invalid values are rejected.

| Resource | Method | Request / response |
|---|---|---|
| `session` | POST | `{ "access_code": "your-demo-code" }`; sets cookie |
| `session` | GET / DELETE | Check sign-in / sign out and revoke session |
| `portfolio` | GET | Tracked companies and last collection timestamps |
| `portfolio` | POST / DELETE | `{ "symbol": "TCS" }`; add/remove one company without replacing others |
| `settings` | GET / PATCH | Monitoring, digest and alert preferences |
| `status` | GET | Collection/extraction/analysis/research progress, errors and scheduler state |
| `refresh` | POST | Queue a monitoring cycle; returns immediately |
| `digest` | GET | Current window; optional `hours`, or paired timezone-qualified `from`/`to` query parameters |
| `digests` | GET | Latest 30 saved scheduled digest windows |
| `alerts` | GET | Saved announcement/EOD alerts |
| `notifications` | GET / PATCH | Latest 100 in-app notifications / `{ "id": "uuid" }` to mark read |
| `company` | GET | Add `symbol=TCS`; latest observations, events and source/evidence IDs |
| `evidence` | GET | Add `id=uuid`; authenticated retained page image where available |
| `research` | POST | Start or reuse active research; returns HTTP 202 and job ID |
| `research` | GET | Latest jobs, or add `id=uuid` for progress/report/documents/evidence |
| `research` | DELETE | `{ "id": "uuid" }`; permanently remove one research job and its saved report/progress |
| `research-retry` | POST | `{ "id": "uuid" }`; explicitly retry a failed research job |

Example settings patch:

```json
{
  "monitoring_enabled": true,
  "monitoring_minutes": 15,
  "digest_hours": 36,
  "price_percent": 4,
  "volume_multiple": 2.5,
  "volume_sessions": 20,
  "announcement_categories": ["results", "M&A", "management_change"],
  "price_enabled": true,
  "volume_enabled": true,
  "announcement_enabled": true
}
```

The interval ranges from 1–1440 minutes; digest windows from 1–168 hours. Changing the digest window starts a new schedule anchor rather than replaying old windows. Monitoring can be paused without deleting collected data. Manual refresh still works while paused. Removing a company preserves its history but stops new portfolio monitoring for it. The browser controls cap the demo watchlist at 50 companies. Invalid tickers return validation/source errors rather than fabricated company data.

## Automatic monitoring

The local server runs PDF preparation, research and portfolio monitoring independently on one database connection. A slow model call can run while new pages are being prepared. Each worker finishes its current batch before starting the next. Extraction resumes promptly while there are pages to save. Research takes turns across eligible jobs. Monitoring rotates between collection, announcement analysis and digest scheduling. Collection covers five companies per batch across the portfolio.

Local ticks allow five-minute model responses. Hosted `/api/tick` uses a 45-second budget within a 60-second function. It advances a persistent stage cursor, so an external scheduler can call it repeatedly with `Authorization: Bearer <CRON_SECRET>`. `npm run monitor` manually performs one local tick. The original protected worker endpoints remain available.

Scheduled digests preserve consecutive publication-time windows. If the app was stopped, each digest tick catches up one window. A digest initially containing pending analysis is refreshed on later digest ticks (latest three incomplete snapshots). Pending/failed coverage remains visible. Notifications for digest windows and alerts are persisted and deduplicated, with separate read acknowledgements. They are **in-app notifications**, retrieved by the frontend while open; no email, mobile OS push, or SMS delivery is configured and no alerts are falsely marked externally sent.

No hosted resources or paid scheduler were provisioned. Local automation stops when the process/computer stops. Hosted automation requires deployment, managed PostgreSQL, private Blob storage, `DEMO_ACCESS_CODE`, `APP_ORIGIN`, `CRON_SECRET`, model keys and a scheduler calling `/api/tick` frequently enough for the desired coverage. The browser must never call worker routes with a scheduler secret.

## Research workflow

```json
{
  "symbol": "TCS",
  "question": "What has management said about growth, and what do the reported numbers support?",
  "source_policy": "primary"
}
```

Document counts are selected adaptively. `source_policy=primary` permits issuer results, presentations and material disclosures alongside the core annual reports and transcripts. `source_policy=assignment` restricts evidence to annual reports and transcripts. The legacy annual_reports/transcripts fields remain accepted for API compatibility but do not cap new jobs. Up to three jobs may be active concurrently; repeating the same active company/question/source-policy request reuses the job. Any NSE ticker can be requested, including a company outside the watchlist, where the primary documents are available.

1. Verify the company on Screener and catalogue all available annual-report, transcript, presentation, results and eligible announcement links. In primary mode, supplement with recent NSE attachment discovery and already saved monitoring disclosures. Preserve link labels, known publication dates, reporting periods and publisher; unknown scopes and dates stay unknown. Select a current annual report, transcript and results filing where available for the initial brief. Screener's financial tables, AI summaries, broker reports, news and model memory are not research evidence. Exchange URLs and the linked company's public website are the allowed primary origins.
2. Reuse a saved primary PDF when the same company and source URL are available, otherwise download it. Research documents remain excluded from portfolio digests and alerts.
3. Index every page's text locally in a PDF.js worker thread, retaining page IDs and source URLs. Cache the index by PDF content hash. Render only a few selected pages for tables or scans.
4. Reserve evidence across business, financials, cash, balance sheet, trajectory, guidance and risks. Rank pages with document-wide term weights and financial headings, suppress near-duplicates, then select exact passages with a per-page share of the character budget. Each model request uses at most 18,000 source characters and 1 image, with no page-count ceiling. The selection is deliberately bounded and can miss relevant material elsewhere.
5. Ask Gemini 3.5 Flash-Lite through generateContent for a short cited brief. Gemini 3.6 Flash is the fallback. An optional Groq text fallback is available through RESEARCH_FALLBACK_PROVIDER=groq after its key is validated. It receives at most 12 complete passages and a shorter output request. The research model pair is independent of monitoring's model settings.
6. Copy text citations from the original indexed passages and validate numerical support. Fiscal-year abbreviations are normalized. Discard statements with unknown references or unsupported figures. Save the supported report, evidence, coverage and elapsed time.
7. Allow up to three actual model requests, each up to 30 seconds, within a 180-second processing budget starting at the first worker claim. A malformed completed reply may receive one corrective attempt. Provider cooldowns remain respected. A temporary provider outage preserves the prepared sources for a later attempt; quota exhaustion pauses for manual retry. Invalid completed outputs can leave an internal source-excerpt record, which is suppressed as a research report in the UI.

Without a question the default report is a broad company overview aligned with the eight research areas in the assignment. The question field is optional and can be used for focused follow-ups. The default report is a focused brief. All text is indexed locally, while the AI sees a bounded selection. This trades exhaustive coverage for demo latency. Sparse scans have limited text-based retrieval, so their selected images provide only sampled coverage. Questions needing comparisons across many periods can require more evidence than this mode selects.

The UI distinguishes text indexing from AI review. It shows the pages selected for a brief and counts pages with a saved model result. If a fallback uses fewer passages, actual reviewed-page coverage is stored separately. Progress advances when a request returns and passes validation.

The original exhaustive reader is retained for compatibility with jobs explicitly carrying the internal option mode=full. New browser and CLI research requests use focused mode. Existing reports remain readable. Failed jobs can be retried through the usual API. Retry resets the request counter and processing clock while retaining source files and indexes.

The research workflow does not compute a financial model, deliver a four-quarter guidance scorecard or prove the semantic correctness of each financial interpretation. Source quotes and numerical checks provide traceability. Original PDFs and derived assets remain stored because automatic reference-aware cleanup is not implemented.

CLI equivalents (stop the local PGlite server first):

```bash
npm run research -- TCS "Explain business growth and explicit guidance"
npm run research -- run
npm run research -- show RESEARCH_JOB_UUID
```

## Verification

The isolated tests cover HTTP session controls, request validation, watchlist edits, settings, digest window persistence, notification deduplication, competing scheduler owners, whole-portfolio rotation, transaction isolation, real PDF extraction, research citations, partial evidence, retries and expired research leases. Model responses are mocked in these tests; fixture reports are never inserted into the real catalogue. Live checks additionally verify primary-source discovery/downloads; representative full-company financial accuracy remains an evaluation task, not a claim established by unit tests.

Live checks on 13 November 2026: the cookie API successfully read the existing three-company local catalogue; TCS source discovery found the annual report and earnings transcript, and both returned real PDFs (about 17.4 MB and 0.72 MB). Flash-Lite extracted validated facts from two pages of the 29-page transcript. The following research synthesis request received HTTP 503 from Gemini 3.6 Flash, so no full live research result is claimed. The automated tests cover preserving reading batches across this failure; the isolated excerpt test did not insert an incomplete company report into the catalogue.

## Included test frontend

The UI is in `web/index.html`, `web/app.js` and `web/styles.css`, with no framework or external asset dependency. The server serves only those known static files, never arbitrary repository paths or environment files. The existing cookie API is reused; model/worker credentials do not reach the browser.

- Portfolio: add/remove tickers, EOD close/session/volume, change versus the prior saved session, historical close chart, saved developments and a refresh request.
- Watcher: saved interval/digest/alert preferences, pause/resume and a status/error dialog.
- Digests and alerts: publication-window selection, routine disclosure collapse, saved context with timestamps, scheduled digest history and read acknowledgements for alerts.
- Research: question presets, source policy and discovered/selected source coverage, job history, queued/running/failed progress, explicit retry, complete/partial reports, limitations, source quotations and authenticated page images.

Views poll the backend while the tab is visible. Focused input fields are preserved, and unchanged data does not rebuild the content on every poll. A browser sync timestamp indicates the last successful API read, not the freshness of an upstream price or filing. Saved price sessions and analysis timestamps remain explicit. Desktop and mobile layouts were checked in a browser. Report/citation/retry states were also checked using an isolated, clearly labelled fixture database; fixture reports were not inserted into the real catalogue. A real TCS research request was queued through the UI; model-provider availability and the server's background runner still govern completion.

Evidence-budget comparisons and their limits are recorded in output/RESEARCH-selection-findings.md.

## Adaptive research

The initial evidence pass has no page-count ceiling. Its size is controlled by an 18,000-character input budget and one rendered image. All source text is indexed locally. Exact passages are ranked across topics and reserved for coverage.

The initial model response includes the brief and up to four specific evidence gaps. The worker persists the validated findings, citations and selection before attempting expansion. The API exposes that initial result while the job is running. The UI labels it as an initial brief.

Targeted expansion first searches the full index for material gaps and explicit requested periods. When indexed evidence is insufficient, it selects and fetches additional sources from the catalogue, indexes their text locally, and sends relevant new passages with a compact list of saved findings. Additional useful passes can continue when the model identifies further gaps, within the shared request/time budgets. Exact repeated passages are suppressed with period and scope context. The backend merges supported additional findings and retains original citations. The expansion has the same per-request resource allowance. The existing three actual request attempts and three-minute processing budget remain shared across the job.

Expansion stops when no material gap is identified, no relevant new evidence is found, the budget is exhausted, or the targeted pass adds no findings. Missing historical sources remain explicit gaps. Earlier annual reports, transcripts and results are fetched only as evidence needs and available budgets warrant. A 30-second source-acquisition allowance per expansion reserves time for the model answer; this is a time budget, not a document-count cap. Explicit historical comparisons drive period selection; comparative financial pages can avoid extra downloads. Selection heuristics do not prove that every requested period is fully analysed.

Each successful pass is checkpointed in research_state.adaptive. A restarted worker resumes from this checkpoint after its lease expires and does not rerun the initial successful model call. A failed expansion preserves the initial result. Source indexes remain reusable across jobs; validated finding checkpoints belong to the current research job.

The result reports successful evidence passes, additional findings, unresolved questions and a stop reason. Source coverage refers to passages from pages, not full-document AI reading.

## Research quality checks

The brief distinguishes capital allocation from explicit operating guidance. Macroeconomic forecasts are excluded from company guidance. Narrative-versus-numbers findings require a quantitative outcome and comparison. Inventory practices alone prompt a search for operating cash flow, PAT, capex and working-capital movements.

Retrieval reserves cash-flow statement headers and operating/investing rows together and includes profit-statement evidence. Gap retrieval can reserve finance-subsidiary context before consolidated debt is interpreted. Missing manufacturing/financing splits remain open questions.

Internal citation markers are stripped from statement text before numerical validation. Original text passages and table headers remain the evidence for numerical claims. Findings with unsupported figures or unknown references remain excluded. Expansion ignores exact repeats of already validated findings before treating old citation references as failures.

Final source-coverage notes are rebuilt after expansion. Capital allocation is an additional report section where supported. Subsidiary bear-case findings require evidence of scale or group impact rather than an incidental operating anecdote.

## Model quota waits

Temporary provider outages before the first validated brief leave the job waiting with prepared sources. Request-limit failures pause the job until the user retries. The UI shows the provider retry time for request limits. Quota-paused jobs have no automatic next attempt, including after the reset time. Cooldowns are shared by model across monitoring and research.

A resumed provider wait resets the per-attempt processing clock and call allowance while retaining PDFs, indexes and any validated adaptive checkpoint. Consecutive short outages use increasing delays. An already validated initial brief remains available if a later expansion fails.

Historical source-excerpt fallbacks are suppressed in the research report UI and can be explicitly requeued. Their raw passages remain available in backend records rather than being shown as an AI financial snapshot.

## Secondary Gemini credential

Set GEMINI_API_KEY_SECONDARY in the ignored .env file or server secret configuration and restart the process. Each configured Gemini model tries the secondary credential when the primary reports HTTP 429 or has a saved quota cooldown. Temporary overload alone does not switch credentials. Cooldowns are keyed by model and an opaque credential fingerprint; secret keys are never stored in cooldown rows.

If available model/key combinations are request-limited, research requires a user-triggered retry and shows the reset time. The initial validated brief survives an expansion quota failure and the expansion can be retried from its checkpoint. Monitoring analysis jobs also stop automatic retries after request-limit failures. Saved sources and indexes remain reusable.

Google applies rate limits per project. Two keys in the same project share that project's quota. A secondary credential can only provide capacity within its project's permitted limits.


## Adaptive source catalogue

`research_sources` stores discovered links and metadata without downloading every document. `research_documents` contains only selected documents and records the catalogue ID, selection reason, resolved primary URL and known source metadata. The browser shows both selected sources and links not yet downloaded or reviewed. Unresolved questions can populate the research form for a deeper follow-up.

Quarterly-results links on Screener may require registration. Only PDF responses resolving to issuer/exchange origins become evidence; login pages and Screener financial tables never do. The worker can search NSE filings around a requested older reporting period to find a direct attachment. Initial exchange discovery covers 90 days with a 12-second network allowance. NSE's official `.in` redirect and archives are supported. Unavailable source discovery/downloads produce visible coverage limitations and preserve the initial validated brief.

Results filings are the first supplementary source priority, followed by presentations and post-report material filings. Shareholding/pledge, governance/related-party and offer documents are selected for specific evidence gaps when their links are discovered. No standalone SEBI prospectus or exchange XBRL archive crawler is included. Credit-rating rationales, broker notes, news and other third-party analysis remain excluded. Management targets are distinguished from reported outcomes, and source metadata is a retrieval hint rather than cited financial evidence.

Downloaded files, full-text indexes, selected images, reports and checkpoints still have no automatic expiry policy. This change does not delete historical research data. Content-addressed file storage and compatible saved asset/index reuse avoid identical downloads and repeated preparation; validated finding checkpoints remain job-specific.

Verification on 15 November 2026: public TVSMOTOR discovery produced 79 source links and selected current core documents plus a direct NSE results attachment. Its 4.3 MB, 41-page results filing downloaded in 293 ms and indexed locally in 853 ms in one check; these timings are not a service guarantee. No live model calls were made for this change. Mocked integration tests exercise saved initial reports, dynamic older-source retrieval, citations, independent source policies, request budgets, deduplication and quota-pause/resume behaviour.


## Deleting research

Research history and the open report have a Delete action with confirmation. The authenticated `DELETE /api/app?resource=research` endpoint accepts `{ "id": "uuid" }`. It removes the chosen job, citations, batches, selected-document records and discovered-source catalogue in one transaction. Other jobs, company/portfolio records, PDFs, cached text indexes and images are retained for reuse. This is job deletion, not file-cache cleanup.

Deletion also works while a job is queued, waiting or running. The transaction locks the job against worker checkpoints; after deletion, a worker cannot publish a late result or retry it. An already-sent model request may finish and consume its provider allowance. Browser history updates immediately and ignores stale polling results for the deleted ID.


## Research reliability checks

Generic guidance gaps no longer walk backwards through every quarterly result or presentation after a failure. Explicit historical-period requests still retrieve those periods. Registration-gated results wrappers are not downloaded: the worker looks for legitimate exchange attachments first. Known authentication/permission failures suppress further optional requests to that origin.

Source acquisition reserves preparation time and indexing has its own bounded allowance within the overall research budget. Optional failures are listed separately from core-source gaps. Reports expose elapsed time since creation separately from the current attempt, and selected-page counts represent passages rather than complete page reading.

Conservative financial checks reject obvious interim/full-year duration conflicts, unverifiable or inconsistent CAGR endpoints, and narrative comparisons without numerical expectations and outcomes. These are guardrails, not a complete structured financial accounting validator. Financial source headers, metric associations, scope and units still require representative source-level evaluation. Saved reports are not retroactively rewritten.


## Interactive research exhibits

Reports open with three selected cited findings, risk/balance-sheet context and a leading unresolved question. Analytical sections expand in place; a compact section navigator preserves the report route. Chart/table views and value inspection expose exact units, scope, periods, quotations and source pages. Revenue/PAT comparisons and matched PAT/net-operating-cash conversion are calculated deterministically from admitted observations; observations with conflicting values or incompatible units/scopes/durations are excluded from comparisons. Revenue-versus-profit divergence is described without inventing a cause.

The existing model reply optionally includes up to 16 observations and four dated numerical commitments. No additional model call is introduced. Exact text quotations must establish the metric, value, units, scope and start/end dates. Ambiguous tables and visual-only transcriptions are conservatively omitted from exhibits. Commitment publication must precede its target period; outcomes require compatible metrics and periods. Missing comparisons remain visible. This conservative admission can produce sparse exhibits and does not constitute complete semantic financial validation. Older reports display their cited prose with an explicit no-chart-data explanation; no values are parsed from historical prose or backfilled.

Design references only (never company evidence): CFA Research Challenge reports (https://www.cfainstitute.org/insights/events/research-challenge/past-champions), Koyfin (https://www.koyfin.com/features/) and Quartr Pro (https://quartr.com/products/quartr-pro). The implementation uses native HTML/CSS bars and accessible tables without external chart dependencies. Source retrieval, free-tier call budgets, manual quota retry and retention policies are preserved.

## Research market perspective

Authenticated `GET /api/app?resource=market&symbol=TCS` retrieves up to 400 calendar days through the existing Yahoo source parser, including ticker/currency/timezone checks and completed-session filtering. It never adds portfolio membership or invokes a model. A bounded 100-symbol process-local cache coalesces concurrent requests and refreshes after five minutes. A failed refresh can retain explicitly stale history; an initial failure leaves the research report usable with a retry action.

The report prominently displays the last completed close, change versus the prior completed session, daily volume and its ratio to the prior available (up to 20) sessions' average. A price line and aligned volume bars support point inspection, keyboard session selection and a table alternative. Date ranges show their actual available dates; high/low and raw close-price return refer to that selection, not an assumed annual period. Returns exclude dividends and are not split-adjusted total returns. Ad-hoc research can explicitly add the company using the existing portfolio endpoint; already tracked companies show membership instead.

No intraday quote is introduced. Timestamps and Yahoo source links remain visible. Existing model budgets, manual quota retry and storage retention are unchanged. Automated tests cover cached market data, failures and authentication; rendering checks cover charts, volume, tables and portfolio button states.

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
  "annual_reports": 1,
  "transcripts": 1
}
```

The source counts default to one annual report and one transcript; maxima are three and four. These are explicit source limits, not a promise to cover the last four quarters by default. Up to three jobs may be active concurrently; repeating the same active company/question/source-count request reuses the job. Any NSE ticker can be requested, including a company outside the watchlist, where the primary documents are available.

1. Verify the company on Screener and discover raw annual-report and transcript links. Screener's financial tables, AI summaries, broker reports, news and model memory are not research evidence. Exchange URLs and the linked company's public website are the allowed primary origins.
2. Reuse a saved primary PDF when the same company and source URL are available, otherwise download it. Research documents remain excluded from portfolio digests and alerts.
3. Index every page's text locally in a PDF.js worker thread, retaining page IDs and source URLs. Cache the index by PDF content hash. Render only a few selected pages for tables or scans.
4. Reserve evidence across business, financials, cash, balance sheet, trajectory, guidance and risks. Rank pages with document-wide term weights and financial headings, suppress near-duplicates, then select exact passages with a per-page share of the character budget. Send at most 8 evidence pages, 18,000 source characters and 1 image. The selection is deliberately bounded and can miss relevant material elsewhere.
5. Ask Gemini 3.5 Flash-Lite through generateContent for a short cited brief. Gemini 3.6 Flash is the fallback. An optional Groq text fallback is available through RESEARCH_FALLBACK_PROVIDER=groq after its key is validated. It receives at most 12 complete passages and a shorter output request. The research model pair is independent of monitoring's model settings.
6. Copy text citations from the original indexed passages and validate numerical support. Fiscal-year abbreviations are normalized. Discard statements with unknown references or unsupported figures. Save the supported report, evidence, coverage and elapsed time.
7. Allow up to three actual model requests, each up to 30 seconds, within a 180-second processing budget starting at the first worker claim. A malformed completed reply may receive one corrective attempt. Provider cooldowns remain respected. A provider outage yields an explicitly labeled source-excerpt view when readable evidence exists. It does not count as a successful AI brief.

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
- Research: question presets, source counts, job history, queued/running/failed progress, explicit retry, complete/partial reports, limitations, source quotations and authenticated page images.

Views poll the backend while the tab is visible. Focused input fields are preserved, and unchanged data does not rebuild the content on every poll. A browser sync timestamp indicates the last successful API read, not the freshness of an upstream price or filing. Saved price sessions and analysis timestamps remain explicit. Desktop and mobile layouts were checked in a browser. Report/citation/retry states were also checked using an isolated, clearly labelled fixture database; fixture reports were not inserted into the real catalogue. A real TCS research request was queued through the UI; model-provider availability and the server's background runner still govern completion.

Evidence-budget comparisons and their limits are recorded in output/RESEARCH-selection-findings.md.

## Adaptive research

The initial evidence pass has no page-count ceiling. Its size is controlled by an 18,000-character input budget and one rendered image. All source text is indexed locally. Exact passages are ranked across topics and reserved for coverage.

The initial model response includes the brief and up to four specific evidence gaps. The worker persists the validated findings, citations and selection before attempting expansion. The API exposes that initial result while the job is running. The UI labels it as an initial brief.

One targeted expansion searches the full index for new passages matching material gaps, excludes previously submitted passages and sends the new evidence with a compact list of saved findings. The backend merges supported additional findings and retains original citations. The expansion has the same per-request resource allowance. The existing three actual request attempts and three-minute processing budget remain shared across the job.

Expansion stops when no material gap is identified, no relevant new evidence is found, the budget is exhausted, or the targeted pass adds no findings. Missing historical sources remain explicit gaps. This worker does not automatically download additional historical transcripts beyond the requested source counts.

Each successful pass is checkpointed in research_state.adaptive. A restarted worker resumes from this checkpoint after its lease expires and does not rerun the initial successful model call. A failed expansion preserves the initial result. Source indexes remain reusable across jobs; validated finding checkpoints belong to the current research job.

The result reports successful evidence passes, additional findings, unresolved questions and a stop reason. Source coverage refers to passages from pages, not full-document AI reading.

## Research quality checks

The brief distinguishes capital allocation from explicit operating guidance. Macroeconomic forecasts are excluded from company guidance. Narrative-versus-numbers findings require a quantitative outcome and comparison. Inventory practices alone prompt a search for operating cash flow, PAT, capex and working-capital movements.

Retrieval reserves cash-flow statement headers and operating/investing rows together and includes profit-statement evidence. Gap retrieval can reserve finance-subsidiary context before consolidated debt is interpreted. Missing manufacturing/financing splits remain open questions.

Internal citation markers are stripped from statement text before numerical validation. Original text passages and table headers remain the evidence for numerical claims. Findings with unsupported figures or unknown references remain excluded. Expansion ignores exact repeats of already validated findings before treating old citation references as failures.

Final source-coverage notes are rebuilt after expansion. Capital allocation is an additional report section where supported. Subsidiary bear-case findings require evidence of scale or group impact rather than an incidental operating anecdote.

## Model quota waits

Temporary model failures before the first validated brief now leave the job waiting with its prepared sources. The next eligible attempt uses the provider's retry window, including RetryInfo durations and daily-limit delays in error bodies. Cooldowns are shared by model across monitoring and research.

A resumed provider wait resets the per-attempt processing clock and call allowance while retaining PDFs, indexes and any validated adaptive checkpoint. Consecutive short outages use increasing delays. An already validated initial brief remains available if a later expansion fails.

Historical source-excerpt fallbacks are suppressed in the research report UI and can be explicitly requeued. Their raw passages remain available in backend records rather than being shown as an AI financial snapshot.

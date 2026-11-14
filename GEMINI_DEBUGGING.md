# Gemini diagnostics

## Live findings, 12 November 2026

The configured key successfully accessed `models/gemini-3.8-flash` (HTTP 200). A minimal synthetic prompt then failed with HTTP 503 on both the Interactions and generateContent endpoints. Google's response explicitly reported that the model was experiencing high demand.

This isolates the observed failure from the document parser, page images, financial-output schema, and key authentication. Even a request containing only “Reply with the single word OK” failed. It does not prove the full analysis prompt will succeed once capacity returns; that still requires a live end-to-end check.

The initial diagnostics did not change the model, key or billing settings. The subsequently requested fallback is now configured explicitly as described below; billing settings remain unchanged.

## Reproduce safely

```bash
npm run diagnose:gemini
# Optional comparison of both endpoints, still with synthetic text only:
npm run diagnose:gemini -- --compare-endpoints
```

The diagnostic reads the runtime `.env` key, checks access to the configured model, then makes one minimal generation request. It does not open the company database, read files, or send company disclosures. Comparison mode adds one generateContent request using the same model. Results include HTTP status, elapsed time and a redacted provider reason. The key never appears in the request URL or reported output.

Interpretation:

- `authentication_or_access_error`: credentials or permissions need attention.
- `model_unavailable`: the configured model is unavailable to this request.
- `quota_limited`: project limits require waiting or reviewing account limits.
- `model_overloaded`: the selected model returned HTTP 503 for minimal requests.
- `timeout`: no usable response arrived within the diagnostic timeout.
- `minimal_request_succeeded`: connectivity/auth/basic generation worked; next check the actual structured multimodal worker.

Diagnostics themselves make model requests and can consume account quota. They are explicit operator commands, not an automatically repeating health check.

## Worker changes

- Preserve Google's useful error message/code, while redacting the configured key and other recognisable key strings. Never persist the full provider body or request headers.
- Classify timeouts and network failures as transient, rather than leaving only an opaque abort message.
- Apply a shared durable cooldown **per configured model** for 503/timeouts/network failures as well as 429s. Another worker does not immediately bombard the same unavailable model.
- Retry transient provider failures on subsequent worker runs with bounded exponential delay and jitter. A long service outage does not permanently exhaust the five-failure document-processing limit.
- Pause non-retryable provider configuration failures (400/401/402/403/404) until explicitly retried after a fix. `npm run analyse -- --retry-failed` resets the job classification/counter while preserving any active provider cooldown.
- Keep processing/validation failures bounded at five consecutive failures. Preserve already validated batches and original inputs.
- Expose `provider_unavailable` distinctly from rate limiting and validation errors, and include `error_kind` in inspection output.

The database adds `processing_jobs.error_kind`. The worker is still invoked periodically; these changes do not install a scheduler or start an always-running service.

## Latency controls

`GEMINI_THINKING_LEVEL` can explicitly select `low`, `medium`, or `high`. Empty leaves Google's default unchanged. Lower reasoning can reduce latency, but changes the reasoning budget; it is not a fix for HTTP 503 and has not been silently enabled.

`GEMINI_DIAGNOSTIC_TIMEOUT_MS` and `ANALYSIS_REQUEST_TIMEOUT_MS` now default to 300 seconds per request. Local analysis runs until one eligible disclosure completes, with no total-time or call-count cap. Errors, unavailable models or no eligible jobs still cause a controlled exit; completed batches are retained. The hosted endpoint caps its effective budget at 45 seconds and each request at 40 seconds to fit its 60-second function limit. Larger timeouts cannot guarantee capacity or bypass quota.

Google's [troubleshooting guide](https://aistudio.google.com/docs/troubleshooting) classifies 503/429 as transient and recommends backoff, while client/configuration errors should be corrected rather than repeatedly retried. Active quota remains project-specific.

## Requested fallback, 12 November 2026

At that point the local `.env` and example configuration selected `gemini-3.8-flash` as primary and `gemini-3.5-flash-lite` as the only fallback. Leave `GEMINI_FALLBACK_MODEL` empty to disable switching. No billing setting was changed and no third model/provider is attempted.

Live observations:

- Flash-Lite model access returned HTTP 200 and a minimal Interactions request completed with HTTP 200.
- A public-NSE document request exposed HTTP 400: the structured-output schema produced too many grammar states. The provider schema now retains structure/types/enums/required fields but omits complex range, pattern and length constraints; the original full Zod schema still validates every response locally before acceptance.
- Subsequent public-document requests returned HTTP 503/high demand from Flash-Lite. Full live extraction/synthesis quality remains unverified; a successful minimal request is not a successful document-analysis test.

The pair is enabled with this limitation visible. Transient failures switch only when the other model is outside its cooldown and invocation call/time limits permit another request. Every attempted request counts, including failures. Completed validated batches persist across invocations, record their actual model, and may be reused across the configured pair. Final results include batch/model provenance. Invalid credentials, malformed requests, invalid JSON and invalid citations do not trigger fallback.

Saved completed results are exposed by the digest API with analysis/publication timestamps, a current/stale marker and pending disclosure counts. They are explicitly separate from newly analysed in-window developments; no fixture data is written to the real catalogue. The repository has no frontend yet, so these are UI-ready API fields rather than a rendered banner.

Free eligibility and capacity are governed by the project's active limits. Enabling fallback does not guarantee availability or demonstrate that the project uses the free billing tier. See [Google's model documentation](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), [pricing](https://aistudio.google.com/docs/pricing#gemini-3.5-flash-lite), and [active limits](https://aistudio.google.com/docs/rate-limits).

## Stage split, 13 November 2026

The worker now selects `gemini-3.1-flash-lite` for `page_extraction`, and `gemini-3.6-flash` for `combine_batches`, `page_verification` and `final_synthesis`. Gemini 3.5 Flash is deprecated and reroutes to 3.6; 3.6 is explicit. The 3.8 model and previous 3.5 Flash-Lite fallback are no longer selected by default. The runtime `.env` has been updated without changing API keys or billing settings.

The two new models both passed synthetic live Interactions checks: extraction model access/generation HTTP 200 (~1.8 seconds generation), reasoning HTTP 200 (~24 seconds generation). This does not by itself establish accuracy on filings.

Validated existing page batches are retained and revalidated against the unchanged source input. Intermediate/final synthesis uses its own stage model and source-dependent cache identity. A newly invalid Lite response can be independently reread with original page images by the reasoning model. Invalid findings are never published. A reasoning model outage leaves completed page batches intact. Old global/3.8 cooldowns do not pause the new stage models; each new model keeps its own durable cooldown.

Use `npm run diagnose:gemini -- --stage extraction` or `--stage reasoning` to check them separately. Local five-minute request timeouts and run-to-disclosure-completion behavior remain as configured; hosted invocations retain their enforced shorter budgets.

The live end-to-end test completed Reliance's one-page CLSA India Forum announcement in about 15 seconds: Flash-Lite read the page, Flash produced final synthesis, and the result passed validation and was persisted. One routine investor-meeting event was saved with source/page evidence, both model IDs, full prepared-page coverage and an analysis timestamp. No immediate alert was created. The digest exposes the saved result. This is a successful test on one routine announcement, not a representative financial-table accuracy evaluation. Three other collected disclosures remain pending/retryable; the test did not process the whole portfolio. All 87 automated tests passed, including stage selection, previous-batch reuse, independent cooldowns, reasoning recovery and rereading rejected extraction against original pages.

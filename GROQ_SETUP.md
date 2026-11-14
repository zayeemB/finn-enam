# Try Groq's Qwen vision model

Groq is the API hosting service, separate from xAI's Grok. This integration uses only `qwen/qwen3.8-27b`, with full page text, labelled PNG/JPEG images and JSON mode. Existing local schema, citation, number and page-coverage validation still applies before saving results. JSON mode alone does not guarantee the financial facts are correct.

## Setup

Create a key at <https://console.groq.com/keys> and add it to the ignored `.env`:

```dotenv
GROQ_API_KEY=your-key-here
```

Never put the real key in `.env.example` or chat. No new dependency or database migration is required. The current Gemini configuration remains in effect until explicitly changed.

```bash
# Synthetic text only, no company data or database access:
npm run diagnose:groq

# Explicit Groq-only test of the real analysis worker:
npm run analyse:groq
```

The real worker sends the next eligible disclosure and page images to Groq, stores only validated batches/results, and can create local alert candidates. The local command runs until one eligible disclosure completes, allowing five minutes per model request and as many page/synthesis calls as necessary. It exits on errors or no eligible work and retains completed batches. Hosted invocations retain their time/call limits. Existing job retry times still apply; this command does not bypass cooldowns. `--retry-failed` explicitly resets failed-job classifications/counters, while retaining provider cooldowns.

## Choose providers after testing

Use Groq as primary:

```dotenv
ANALYSIS_PROVIDER=groq
ANALYSIS_FALLBACK_PROVIDER=
```

The Gemini primary now uses a dedicated extraction/reasoning split. Groq is available through the explicit Groq-only test command, as a Groq primary, or with Gemini as fallback from a Groq primary. The previous global Gemini-to-Groq fallback configuration is superseded by the Gemini stage routing. For a Groq primary with Gemini fallback:

```dotenv
ANALYSIS_PROVIDER=groq
ANALYSIS_FALLBACK_PROVIDER=gemini
```

The worker attempts at most two configured models. A Groq fallback requires a Groq key; it does not silently use Gemini credentials. With Gemini as primary, the dedicated stage models/settings apply instead; global fallback settings do not control those stages. With Groq as primary and no fallback set, only Groq is used. Set `ANALYSIS_FALLBACK_PROVIDER=gemini` to explicitly use Gemini after a temporary Groq failure.

Cooldowns are isolated by provider/model. Failures consume the invocation call limit, and a job resumes on a later invocation when both models are unavailable or its call/time budget runs out. Configuration and validation errors do not trigger fallback. Actual model IDs, saved source metadata, batch provenance and analysis timestamps remain recorded. Already completed disclosures are not automatically reanalysed when the provider configuration changes.

## Free-plan limits

The documented vision model supports three images per request, but the worker uses one page per batch whenever Groq is in the configured pair to reduce token pressure. `GROQ_MAX_OUTPUT_TOKENS` defaults to 900 and can be set between 256 and 16000. Truncated or invalid JSON is rejected. Large page text and synthesis requests can still exceed the account's token limit; the worker never truncates source pages to fit. The free tier is not a guarantee that the full 50-company workload fits.

Do not enable paid billing merely to run these commands. Usage tier, actual quotas and model availability are controlled by the Groq account. Check [your limits](https://console.groq.com/dashboard/limits), [vision support](https://console.groq.com/docs/vision), and [rate-limit documentation](https://console.groq.com/docs/rate-limits).

## Verification status

Mocked tests cover the multimodal request, JSON handling, incomplete responses, secret redaction, timeout/quota handling, cross-provider failover, separate cooldowns, validated persistence and model provenance. Live tests on 12 November 2026 confirmed that the configured key works: the synthetic structured-output diagnostic succeeded. Public NSE filing tests then exposed three limits:

- One filing response failed the existing metadata-citation check and was not published.
- The account enforced 8,000 total tokens/minute and 1,000 output tokens/minute. A request estimated to exceed the entire output-minute quota was rejected before generation. Such a hard request-size error now pauses the job for a configuration fix rather than repeatedly retrying it as temporary congestion.
- A shorter one-page public announcement tested with a 900-token output cap ended with `finish_reason=length`, so it too was rejected and not published.

The conservative default output cap is now 900, with full-page inputs retained. This does not guarantee a complete analysis fits the free allowance. No successful end-to-end public-filing analysis has been established, and Groq has not been enabled as the automatic fallback. The existing Gemini pair remains configured. Further evaluation needs an output representation that fits the account quota or higher provider limits; raising `max_tokens` alone cannot bypass the account's enforced limit.

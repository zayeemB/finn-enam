# Extraction worker

The collector gathers raw inputs. This worker prepares those inputs for the separate LLM analysis stage. It does not classify announcements, generate financial conclusions, or send alerts.

## Run

Use Node.js 22.13+ (Node 24 also works):

```bash
npm ci
npm run extract
npm run inspect
```

Each call prepares up to ten pages across three jobs within a 45-second working budget. A document larger than the budget is resumed by the next call; the page limit is a batch size, not a truncation limit. The command prints a report and exits. An external scheduler can call the protected `/api/extract` route, using the same `Authorization: Bearer <CRON_SECRET>` header as collection. No schedule or cloud deployment is created automatically.

To reset the retry counter/backoff on failed extraction jobs:

```bash
npm run extract -- --retry-failed
```

Limits are configured in `.env` using the `EXTRACTOR_*` settings in `.env.example`. Hosted limits are capped at 45 seconds of working budget, 40 seconds per renderer operation, and six million rendered pixels per page.

## Data flow

```text
Collector saves original asset and queues an extract job
                         ↓
Worker claims the job with an expiring ownership token
                         ↓
Reads and verifies original file bytes from shared storage
                         ↓
Isolated renderer prepares each page's text + full-page image
                         ↓
Worker saves a content block and progress after every page
                         ↓
After complete preparation, queues one current-input analyse job
```

The worker reads from the existing file-store adapter; it does not contact NSE/Yahoo or download missing original assets itself. A missing or damaged original sets its asset download status back to pending so the collector can recover it.

## Page representation

PDF.js extracts all available text and its position information. It also renders every page through the Node canvas library. A `content_blocks` row contains:

- The asset and source-content hash, page number, and processor version.
- Full text, text-item transforms/coordinates, and relevant annotations/form values.
- A reference to a complete rendered PNG page, its dimensions, file hash, and storage backend.
- Explicit text status (`available`, `none`, or `failed`) and a flag requiring visual analysis.

Tables, diagrams, signatures, and charts remain visible in the rendered page, including content absent from its text layer. This version does not infer table cells or financial meaning. The future analysis worker must consume the page images as well as text; feeding it only text would recreate the information-loss problem.

Scanned pages are valid visual inputs: they have page images with `text_status=none`. No OCR is claimed. Native text-extraction failures can also be covered by the complete rendered page and are explicitly recorded. Asset extraction status `complete` means **all pages have been prepared for analysis**, not that every figure/image has been understood.

Rendered pages use scale 1.5 by default, capped at six million pixels and a longest dimension of 4096 pixels. Full originals remain available for a future targeted higher-resolution crop if needed. Text geometry is stored in PDF page coordinates; rendered dimensions are pixels. No keywords select or discard passages. Null encoding characters are replaced with the Unicode replacement character for PostgreSQL compatibility and counted in an encoding warning.

## Storage and jobs

`content_blocks` stores text/geometry as JSON. Page images are content-addressed files in the same local/private-Blob adapter as original assets. The PNG content type is set on Blob writes. Text/blocks, images, and originals remain working data until the later analysis/retention stage completes. This worker does not delete originals or start their expiry timer.

Schema changes are additive:

- `processing_jobs.lease_token`: distinguishes a reclaimed job from an older worker.
- `processing_jobs.failure_count`: counts consecutive failures separately from successful page batches. A 100-page document does not exhaust its retry allowance just by requiring multiple calls.
- `assets.extraction_metadata` and `extraction_processor_version`: report coverage and identify the preparation version.
- `content_blocks.processor_version` and a unique asset/hash/version/sequence index: prevent duplicate pages and distinguish extraction versions.

The analysis input hash includes the asset's extraction processor version and explicit unsupported status. Current-input and job-ownership checks happen inside each commit transaction. A collector update cannot be overwritten by an older extraction process. Existing evidence snapshots remain independent of expired/replaced working blocks.

## Recovery

- Source checksum verification precedes parsing.
- Completed pages are committed individually. Retries resume after the saved contiguous prefix rather than starting the document again.
- Lease tokens and five-minute leases permit crash recovery while rejecting commits from expired/reclaimed workers.
- Long documents rotate behind waiting jobs after yielding, so one annual report does not monopolise extraction.
- PDF parsing/rendering runs in a worker thread with a time limit and JavaScript heap limit. A stuck renderer can be terminated without blocking the request thread indefinitely.
- Failures use exponential backoff, stopping automatic retries after five consecutive failures. Successful page progress resets consecutive failures. An operator can use `--retry-failed` after resolving the cause.
- Page-image dimensions and raster decode size are bounded. Rendering never executes PDF JavaScript or fetches external links from annotations.
- If a saved derived image cache disappears, its working blocks can be rebuilt from the retained original. Finding-level citation snapshots remain independently retained.

## Supported and incomplete formats

Supported: PDFs and single-frame PNG/JPEG image attachments. Password-protected or dynamic-XFA PDFs, animated PNGs, and other file types are marked unsupported with an explicit reason. Metadata-only analysis may proceed with that limitation visible; unsupported assets are not represented as successfully read documents.

PDF embedded-file attachments are detected and listed. Their contents remain in the original, but are not recursively extracted yet. Such a PDF has `partial` coverage and does not queue full analysis automatically. Failed page renders likewise cannot silently become complete coverage. The partial/failed state is visible in job/asset records.

This extraction component does not perform OCR, spreadsheet extraction, audio transcription or financial interpretation. The separate [analysis worker](ANALYSIS_WORKER.md) interprets prepared text/images using Gemini. No model API key is needed for extraction.

## Hosting

The existing PostgreSQL/private Blob configuration is reused. `/api/extract` is configured for a 60-second function with the extraction thread, PDF.js fonts/CMaps/WASM resources, and native canvas packages included. Runtime parsing resources come from installed packages rather than a CDN. Configure credentials before deployment; hosted integration with those services is not claimed by local testing.

## Validation

`npm test` includes generated PDFs with text, tabular figures, vector charts and scanned pages, plus standalone raster inputs. It checks resumable batches beyond five invocations, retry backoff, source-file recovery, expired-worker rejection, changed-input rejection, fair scheduling, renderer timeouts, unsupported formats, embedded attachments, and endpoint authentication.

The worker was also run against the existing four real collected PDFs (13 pages total). All pages were prepared and four analysis jobs queued. A rendered source page containing text and a table was visually inspected.

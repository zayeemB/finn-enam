# Full research backend test

The completed run tested the existing Reliance cash-quality question against both complete PDFs already collected by the app. It used an isolated local database at data/full-reliance-check-20261114.

## Outcome

The worker read and saved review results for all 216 pages and persisted a partial report. The test did not establish a successful complete research answer.

| Check | Result |
| --- | --- |
| Annual report reviewed | 187 of 187 pages |
| Transcript reviewed | 29 of 29 pages |
| Elapsed run time | 4 hours 26 minutes |
| Model requests | 209 attempts, 193 returned successfully |
| Provider failures | 3 timeouts, 8 HTTP 503 responses, 1 DNS failure, plus cooldown checks |
| Saved page findings | 110 |
| Saved citation records | 123 across 98 source pages |
| Independently matched text quotations | 120 of 120 |
| Visual citations with retained image references | 3 of 3 |
| Page evidence exclusions recorded | 62 |
| Final report status | Partial, source findings |
| Final synthesized report | Rejected by numerical validation |

The provider request counts include page requests that later failed application validation. The visual audit checked retained image references. It did not independently verify every visual transcription or financial interpretation.

## Issues exposed

- Model availability contributed repeated delays even after PDF preparation.
- Page-level statements about missing information were carried forward as document-wide claims. The findings included 31 statements matching common absence phrases, requiring editorial and semantic review.
- The worker recorded 62 page-specific evidence exclusions. A count of reviewed pages therefore does not establish complete extraction of relevant financial facts.
- A further synthesis attempt from the saved findings returned a report but failed the numerical validator. The diagnostic identified the abbreviated fiscal-year text “2025-26”, whose “26” was treated as a new unsupported number. The cited source describes the year using a different representation. This shows the validator needs period-aware handling.
- The full run reached its explicit fallback and persisted source findings. It did not produce the intended finished cash-quality research answer.

## Saved artifacts

- Full job and evidence snapshot in data/full-reliance-check-20261114/result.json
- Request and progress log in data/full-reliance-check-20261114/run.log
- Additional report diagnostic in data/full-reliance-check-20261114/synthesis-diagnostic.json
- Readable partial findings in output/RELIANCE-full-research.md

The live portfolio database was not modified by this test. The isolated database and source files remain available for resuming diagnosis without paying to read all pages again.

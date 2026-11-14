# Selecting research evidence

The assignment offers eight research areas as a menu and asks for concise analysis grounded in annual reports and earnings-call transcripts. The default brief now asks for business and revenue mix, financial snapshot, trajectory, debt and working capital, cash quality, narrative versus numbers, guidance, and bull/bear considerations. Material capital allocation, auditor concerns, contingent liabilities and related-party risks are included where supported.

One annual report and one transcript remain the source defaults. Their comparative figures can support some historical analysis, but they do not establish a complete four-quarter guidance scorecard.

## Experiment

The comparison used complete locally indexed TCS and Reliance annual reports and transcripts. It compared four selection methods across three character/page budgets.

- Ranked selection uses document-wide term weights and financial heading boosts, with source reservations.
- Topic diversity reserves pages for seven evidence themes and suppresses near-duplicates.
- Neighbour selection also includes pages after financial statement anchors.
- Passage selection reserves topics, then chooses exact source passages from dense pages. A per-page allowance prevents one financial table from consuming the full brief budget.

Local coverage checks used heading matches as a rough diagnostic. They do not measure factual completeness. The live comparison checked schema, citation references and numerical support, and counted supported output topics and findings. These checks do not independently prove financial interpretation accuracy.

## Live observations

| Method and source budget | TCS | Reliance |
| --- | --- | --- |
| Topic-diverse whole pages, 18k characters | 30-second model timeout | 6.7 seconds, 8 topics, 14 findings |
| Topic-diverse whole pages, 40k characters | 30-second model timeout | 7.1 seconds, 7 topics, 10 findings |
| Topic-diverse whole pages, 72k characters | 29.5 seconds, 8 topics, 14 findings | 27.2 seconds, 8 topics, 14 findings |
| Initial passage selection, 18k characters | 8.4 seconds, 8 topics, 13 findings | HTTP 503 |
| Initial passage selection, 40k characters | HTTP 503 | HTTP 503 |
| Final passage sharing, 18k character cap | 8.3 seconds, 8 topics, 13 findings | 8.3 seconds, 7 topics, 12 findings |

The final passage runs sent 15,776 characters from 8 TCS pages and 16,000 characters from 8 Reliance pages, with one page image each. The Reliance run excluded two unsupported generated findings. Missing or unsupported topics remain visible through limitations.

Times in this table cover selection/rendering and one model request from an existing index. They exclude PDF discovery, download and initial indexing. Provider timeouts and 503s are shown separately. This small sample cannot establish failure probabilities or prove that smaller inputs cause fewer 503s.

## Chosen default

The default reserves topic coverage and selects exact passages from at most 8 pages, capped at 18,000 source characters and one image. It retains the existing three-attempt limit, 30-second request timeout and three-minute processing budget.

The compact runs already reached 7–8 supported output topics. Moving to 72k characters quadrupled the source-text allowance and increased successful elapsed time substantially, with little additional topic breadth in this sample. Larger inputs can provide more detailed evidence and improve difficult comparisons, but that incremental benefit does not justify making them the initial free-tier brief.

Raw comparisons are stored in RESEARCH-selection-experiment.json, RESEARCH-passages-experiment.json and RESEARCH-final-selection-check.json. These include page selections and generated reports for inspection.

## Product behaviour

The company ticker is sufficient to start research. The question field is optional. A blank question creates the broad overview. Entered questions support focused follow-ups using the same source and citation controls.

Coverage describes excerpts from selected pages. Local indexing of a page does not mean the model read all its contents. Claims of missing evidence are restricted to the selected material.

The final no-prompt TCS end-to-end check completed in 16.6 seconds, including fresh discovery, downloads and text indexing of 390 pages. It used one model request and passages from eight pages. The generated brief is saved in TCS-broad-default-research.md.

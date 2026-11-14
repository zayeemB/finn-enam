# Research performance check

The default research workflow now produces a focused brief from selected primary-source passages. All document text is indexed locally. The AI reviews a bounded selection.

## Bottlenecks and changes

| Bottleneck observed | Implemented change |
| --- | --- |
| 209 model attempts in the previous complete-document run | Usually one request directly produces a cited brief |
| Rendering and submitting every page image | Index full text, render at most two selected pages |
| Long requests and repeated provider retries | Thirty-second request limit, three actual attempts per job and a three-minute processing budget from first claim |
| Exact-quote generation and abbreviated-year failures | Copy original passages, include supporting headers from the same page and normalize fiscal-year abbreviations |
| Cash-flow statements missed during selection | Normalize PDF spacing and strongly rank operating cash-flow statements |
| Repeated downloads and page preparation for new questions | Reuse source PDFs and text indexes by company, source URL and content hash |
| Eight report topics produced filler for narrower questions | Generate only the topics relevant to the user's question |
| Page preparation confused with AI review | Display text indexing and saved AI coverage separately |

## Final live checks

Both checks used the standard research worker, real source discovery, fresh PDF downloads, local text indexing and real Gemini responses in an isolated database. The default research model is Gemini 3.5 Flash-Lite through generateContent. The fallback is Gemini 3.6 Flash.

| Company and question | Total time | Pages indexed | Pages reviewed by AI | Requests | Supported findings | Result |
| --- | --- | --- | --- | --- | --- | --- |
| TCS business, services, growth and risks | 14 seconds | 390 | 12 | 1 | 7 | Completed brief |
| Reliance cash quality, debt and working capital | 11 seconds | 216 | 8 | 1 | 6 | Partial brief, one numerical finding excluded |

All 20 saved text citations from these two checks matched the indexed source text. The TCS report also included one visual citation whose saved page image was available. This audit does not independently establish the semantic accuracy of every financial interpretation.

## Restrictions and failure behaviour

A focused brief selects at most 12 pages and 32,000 source characters, with at most two page images. It can miss relevant information elsewhere in a long report. The selected coverage is shown in the report.

Earlier tuning runs received Gemini 503 errors and timeouts. Successful timings are measurements of these two checks, not a provider availability guarantee. If the models cannot produce a validated answer within the request budget, the app shows labeled source excerpts when readable source text is available. It does not automatically loop for hours.

The configured Groq key returned HTTP 401. Groq is therefore optional and disabled by default. It can be selected using RESEARCH_FALLBACK_PROVIDER=groq after validating the key. Its adapter sends a smaller selection of complete text passages and requests a shorter response to fit the previously observed free-tier allowance.

The three-minute processing budget starts at the first worker claim. Queue time, source availability and a computer that is suspended or stopped can affect wall-clock delivery. Jobs explicitly carrying the internal legacy mode=full still use the original exhaustive reader. New browser and CLI submissions use the focused mode.

## Saved results

- TCS-focused-research.md contains the completed business brief.
- RELIANCE-focused-research.md contains the supported cash-quality brief and its exclusion notice.
- focused-research-verification.json contains the measured counts.
- ui/focused-research-verified.jpg shows the report and saved review counts in the app.

The full regression suite passed 119 tests. Additional research checks passed after the final timing migration.

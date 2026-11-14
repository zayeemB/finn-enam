# FINN backend

The Node.js backend supports portfolio monitoring, saved digest windows, configurable alerts, in-app notifications and on-demand research from primary annual reports/transcripts. The document pipeline prepares complete text and page images, then uses Gemini Flash-Lite for reading and Flash for reasoning.

Start the local frontend, browser API and automatic workers with `npm run dev`, then open `http://127.0.0.1:3001/`. It prints a temporary demo sign-in code unless `DEMO_ACCESS_CODE` is configured. See [BACKEND_APP.md](BACKEND_APP.md) for the frontend API contract, research workflow, scheduling, deployment and verification limits. The buildless frontend lives in `web/` and is served by the same Node server. It includes a portfolio watchlist, saved EOD prices and charts, digests, alerts, watcher preferences, research submission/history, progress, cited reports, source images and retry controls. No separate frontend install or build is needed. Research defaults to a focused brief with full local text indexing, bounded model input, saved citations and explicit page coverage. See [the measured research checks](output/RESEARCH-performance-check.md) for timing and limitations.

```bash
npm ci
npm run portfolio -- RELIANCE TCS HDFCBANK
npm run collect
npm run extract
npm run analyse
npm run digest -- --hours 36
npm run alerts
npm run inspect
```

See [NODE_COLLECTOR.md](NODE_COLLECTOR.md) for collection, [EXTRACTION_WORKER.md](EXTRACTION_WORKER.md) for page preparation, and [ANALYSIS_WORKER.md](ANALYSIS_WORKER.md) for Gemini analysis, alerts and digest outputs. Set `GEMINI_API_KEY` in a local ignored `.env` or server secrets to run analysis. No cloud deployment is activated.

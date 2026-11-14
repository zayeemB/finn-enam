import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SourceClient } from './http.js';
import { fetchDisclosures, fetchPrices, hash, indiaDay } from './sources.js';
import { companies, claimSource, failSource, saveDisclosures, claimAsset, assetFailed, saveAsset } from './repository.js';
import { evaluateMarketAlerts } from './outputs.js';

async function saveMarket(db, company, state, data, now) {
  await db.transaction(async tx => {
    const owned = (await tx.query("SELECT lease_token FROM collection_state WHERE company_id=$1 AND source='yahoo' FOR UPDATE", [company.id])).rows[0];
    if (owned?.lease_token !== state.lease_token) throw new Error('Market collection lease lost');
    for (const row of data.rows) for (const [metric, value] of Object.entries(row.values)) {
      const unit = metric === 'volume' ? 'shares' : 'INR/share';
      const previous = (await tx.query(`SELECT id,value,revision FROM observations WHERE company_id=$1
        AND metric=$2 AND period_end=$3 AND frequency='daily' AND scope='market' AND unit=$4 AND is_current`,
      [company.id, metric, row.day, unit])).rows[0];
      if (previous && Number(previous.value) === value) continue;
      if (previous) await tx.query('UPDATE observations SET is_current=false WHERE id=$1', [previous.id]);
      await tx.query(`INSERT INTO observations(id,company_id,metric,value,unit,period_start,period_end,frequency,scope,source_url,evidence_snapshot,revision,collected_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6,'daily','market',$7,$8,$9,$10)`,
      [randomUUID(), company.id, metric, value, unit, row.day, data.url,
        JSON.stringify({ provider: 'Yahoo', corporate_actions: data.corporateActions }), (previous?.revision || 0) + 1, now]);
    }
    await tx.query(`UPDATE collection_state SET last_successful_fetch_at=$3,last_error=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE company_id=$1 AND source='yahoo' AND lease_token=$2`, [company.id, state.lease_token, now]);
  });
}

function marketDue(last, now, latest) {
  if (!last || indiaDay(new Date(last)) !== indiaDay(now)) return true;
  const hour = date => new Date(+date + 19800000).getUTCHours();
  if (hour(new Date(last)) < 16 && hour(now) >= 16) return true;
  return hour(now) >= 16 && latest !== indiaDay(now) && +now - +new Date(last) >= 3600000;
}

export async function downloadAsset(db, files, client, asset, now) {
  // Metadata equality never stands in for file equality. Conditional requests still contact the source.
  const hasFile = asset.temporary_file_path && asset.storage_backend === files.backend && await files.exists(asset.temporary_file_path);
  const headers = hasFile ? { ...(asset.etag ? { 'If-None-Match': asset.etag } : {}),
    ...(asset.last_modified ? { 'If-Modified-Since': asset.last_modified } : {}) } : {};
  const response = await client.get(asset.source_url, headers);
  if (response.status === 304) {
    if (!hasFile || !asset.content_hash) throw new Error('Source returned 304 without a usable saved file');
    return saveAsset(db, asset, { contentHash: asset.content_hash, size: Number(asset.byte_size),
      key: asset.temporary_file_path, backend: files.backend, filename: asset.filename,
      mediaType: asset.media_type, etag: asset.etag, lastModified: asset.last_modified }, now);
  }
  const body = response.body;
  if (!body.length) throw new Error('Source returned an empty attachment');
  const claimedType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const prefix = body.subarray(0, 1000).toString('utf8').trimStart();
  if (/^(?:<!doctype\s+html|<html|<\?xml)/i.test(prefix)) throw new Error('Source returned a webpage/error rather than an attachment');
  const mediaType = prefix.startsWith('%PDF-') ? 'application/pdf' : claimedType;
  const key = await files.put(body);
  const expected = hash(body);
  if (key !== expected) throw new Error('File storage hash mismatch');
  return saveAsset(db, asset, { contentHash: expected, size: body.length, key, backend: files.backend,
    filename: basename(new URL(asset.source_url).pathname), mediaType,
    etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') }, now);
}

export async function collect(db, files, options = {}) {
  const now = options.now || new Date();
  const budgetMs = options.budgetMs ?? 45000;
  const companyLimit = options.companyLimit ?? 5;
  const downloadLimit = options.downloadLimit ?? 10;
  const bootstrapHours = options.bootstrapHours ?? 24;
  const overlapMinutes = options.overlapMinutes ?? 60;
  if (!Number.isFinite(+now) || ![budgetMs, bootstrapHours].every(n => Number.isFinite(n) && n > 0) ||
      ![companyLimit, downloadLimit, overlapMinutes].every(n => Number.isInteger(n) && n >= 0)) throw new Error('Invalid collection limits or clock');
  const deadline = Date.now() + budgetMs;
  const client = options.client || new SourceClient({ deadline });
  const disclosureFeed = options.disclosureFeed || fetchDisclosures;
  const priceFeed = options.priceFeed || fetchPrices;
  const report = { startedAt: now.toISOString(), companies: [], downloads: [], status: 'ok' };
  const portfolio = await companies(db);
  if (!portfolio.length) throw new Error('Portfolio is empty. Run npm run portfolio -- RELIANCE TCS first.');
  const processDownloads = async limit => {
    for (let i = 0; i < limit && Date.now() + 1000 < deadline; i++) {
      const asset = await claimAsset(db, now, { force: options.revalidate === true,
        revalidateMinutes: options.revalidateMinutes ?? 15 });
      if (!asset) break;
      try { report.downloads.push({ status: 'ok', ...await downloadAsset(db, files, client, asset, now) }); }
      catch (error) {
        await assetFailed(db, asset, error, now);
        report.downloads.push({ assetId: asset.id, status: 'failed', error: error.message }); report.status = 'partial';
      }
    }
  };
  // A slow/unavailable discovery feed must not indefinitely starve previously saved downloads.
  await processDownloads(Math.min(2, downloadLimit));
  for (const company of portfolio.slice(0, companyLimit)) {
    if (Date.now() + 1000 >= deadline) break;
    const state = await claimSource(db, company.id, 'nse', now);
    if (!state) continue;
    const item = { symbol: company.nse_symbol };
    report.companies.push(item);
    try {
      const start = new Date(state.last_successful_fetch_at ? +new Date(state.last_successful_fetch_at) - overlapMinutes * 60000 : +now - bootstrapHours * 3600000);
      const rows = await disclosureFeed(client, company.nse_symbol, start, now);
      const saved = await saveDisclosures(db, company.id, state, rows, now);
      item.disclosures = { status: 'ok', fetched: rows.length, ...saved, from: start.toISOString(), to: now.toISOString() };
    } catch (error) {
      await failSource(db, company.id, 'nse', state.lease_token, error);
      item.disclosures = { status: 'failed', error: error.message }; report.status = 'partial';
    }
    if (options.prices === false || Date.now() + 1000 >= deadline) continue;
    const previous = (await db.query("SELECT last_successful_fetch_at FROM collection_state WHERE company_id=$1 AND source='yahoo'", [company.id])).rows[0];
    const latest = (await db.query("SELECT max(period_end)::text AS day FROM observations WHERE company_id=$1 AND metric='close' AND is_current", [company.id])).rows[0].day;
    if (!marketDue(previous?.last_successful_fetch_at, now, latest)) { item.prices = { status: 'skipped' }; continue; }
    const marketState = await claimSource(db, company.id, 'yahoo', now);
    if (!marketState) continue;
    try {
      const start = latest ? new Date(+new Date(`${latest}T00:00:00+05:30`) - 7 * 86400000) : new Date(+now - 120 * 86400000);
      const data = await priceFeed(client, company.nse_symbol, start, now);
      await saveMarket(db, company, marketState, data, now);
      item.prices = { status: 'ok', sessions: data.rows.length };
    } catch (error) {
      await failSource(db, company.id, 'yahoo', marketState.lease_token, error);
      item.prices = { status: 'failed', error: error.message }; report.status = 'partial';
    }
  }
  await processDownloads(downloadLimit - report.downloads.length);
  report.remainingAssets = Number((await db.query("SELECT count(*) AS count FROM assets WHERE is_current AND download_status IN ('pending','failed')")).rows[0].count);
  report.marketAlertsCreated=await evaluateMarketAlerts(db,now);
  report.finishedAt = new Date().toISOString();
  return report;
}

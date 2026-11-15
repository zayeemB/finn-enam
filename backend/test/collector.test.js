import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db.js';
import { localFiles } from '../files.js';
import { collect } from '../collector.js';
import { setPortfolio, companies, snapshot, claimSource, jobInputIsCurrent } from '../repository.js';
import { hash, parseDisclosures, parsePrices } from '../sources.js';
import { validateSourceUrl } from '../http.js';
import { authorised } from '../../api/collect.js';
import {watchlist} from '../app-state.js';

const NOW = new Date('2026-11-12T04:00:00Z');
let db, directory, files, rows, body, fail, requests;
before(async () => { db = await openDatabase({ memory: true, connectionString: '' }); });
after(async () => { await db.close(); });
beforeEach(async () => {
  await db.query('TRUNCATE companies,portfolios CASCADE');
  directory = await mkdtemp(join(tmpdir(), 'finn-node-test-'));
  files = localFiles(directory);
  rows = [disclosure()]; body = Buffer.from('%PDF-1.7\noriginal bytes including tables and images'); fail = false; requests = [];
  await setPortfolio(db, ['TEST']);
});
afterEach(async () => rm(directory, { recursive: true, force: true }));
function disclosure(overrides = {}) {
  return { source: 'nse', sourceKey: 'announcement-1', title: 'General update',
    sourceUrl: 'https://nsearchives.nseindia.com/corporate/file.pdf',
    publishedAt: new Date(+NOW - 60000).toISOString(),
    rawMetadata: { anyField: 'Unfiltered data', obscureDetail: { nested: 'Important fact without keywords' } },
    assets: [{ sourceUrl: 'https://nsearchives.nseindia.com/corporate/file.pdf' }], ...overrides };
}
function options(extra = {}) {
  return { now: NOW, prices: false, budgetMs: 30000,
    disclosureFeed: async () => rows,
    client: { async get(url, headers) {
      requests.push({ url, headers });
      if (fail) throw new Error('Network unavailable');
      return { status: 200, body, headers: new Headers({ 'content-type': 'application/pdf' }) };
    } }, ...extra };
}
async function run(t, extra = {}) {
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return collect(db, files, options(extra));
}

test('collector retains all metadata and original bytes; only extract jobs, no interpretation', async t => {
  const report = await run(t);
  assert.equal(report.status, 'ok');
  const saved = (await db.query('SELECT * FROM disclosures')).rows[0];
  assert.deepEqual(saved.raw_metadata, rows[0].rawMetadata);
  const asset = (await db.query('SELECT * FROM assets')).rows[0];
  assert.equal(asset.content_hash, hash(body));
  assert.deepEqual(await files.get(asset.temporary_file_path), body);
  assert.equal(asset.expires_at, null); // Never expire unprocessed evidence on a timer.
  const counts = (await snapshot(db)).counts;
  assert.equal(counts.events, 0);
  assert.equal(counts.content_blocks, 0);
  const jobs = (await db.query('SELECT * FROM processing_jobs')).rows;
  assert.deepEqual(jobs.map(j => j.job_type), ['extract']);
  assert.ok(await jobInputIsCurrent(db, jobs[0]));
});

test('repeated source IDs do not duplicate disclosures, assets, or jobs', async t => {
  await run(t);
  await collect(db, files, options({ now: new Date(+NOW + 60000) }));
  const result = await snapshot(db);
  assert.equal(result.counts.disclosures, 1);
  assert.equal(result.counts.assets, 1);
  assert.equal(result.counts.processing_jobs, 1);
  assert.equal(requests.length, 1);
});

test('same URL can change without metadata changes; supersedes old extraction', async t => {
  await run(t);
  const old = (await db.query('SELECT * FROM processing_jobs')).rows[0];
  body = Buffer.from('%PDF-1.7\nchanged table, same URL and metadata');
  await collect(db, files, options({ now: new Date(+NOW + 16 * 60000) }));
  const jobs = (await db.query('SELECT * FROM processing_jobs ORDER BY created_at')).rows;
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].status, 'superseded');
  assert.equal(jobs[1].input_hash, hash(body));
  assert.equal(await jobInputIsCurrent(db, old), false);
  assert.equal((await snapshot(db)).counts.disclosures, 1);
});

test('a source reverting to previously processed bytes queues that input again', async t => {
  await run(t);
  const original = body;
  const originalJob = (await db.query('SELECT * FROM processing_jobs')).rows[0];
  await db.query("UPDATE processing_jobs SET status='completed'");
  await db.query("UPDATE assets SET extraction_status='complete'");
  body = Buffer.from('%PDF-1.7\nupdated content B');
  await collect(db, files, options({ now: new Date(+NOW + 16 * 60000) }));
  body = original;
  await collect(db, files, options({ now: new Date(+NOW + 32 * 60000) }));
  const current = (await db.query('SELECT * FROM processing_jobs WHERE id=$1', [originalJob.id])).rows[0];
  assert.equal(current.status, 'queued');
  assert.ok(await jobInputIsCurrent(db, current));
});

test('failed downloads remain retryable after discovery checkpoint advances', async t => {
  fail = true;
  const first = await run(t);
  assert.equal(first.status, 'partial');
  assert.equal((await db.query("SELECT last_successful_fetch_at FROM collection_state WHERE source='nse'")).rows[0].last_successful_fetch_at.toISOString(), NOW.toISOString());
  assert.equal((await db.query('SELECT download_status FROM assets')).rows[0].download_status, 'failed');
  fail = false; rows = [];
  await collect(db, files, options({ now: new Date(+NOW + 120000) }));
  assert.equal((await db.query('SELECT download_status FROM assets')).rows[0].download_status, 'downloaded');
});

test('feed failure preserves checkpoint; next request starts with overlap', async t => {
  await run(t);
  await collect(db, files, options({ now: new Date(+NOW + 60000), disclosureFeed: async () => { throw new Error('NSE down'); } }));
  const state = (await db.query("SELECT * FROM collection_state WHERE source='nse'")).rows[0];
  assert.equal(state.last_successful_fetch_at.toISOString(), NOW.toISOString());
  let start;
  await collect(db, files, options({ now: new Date(+NOW + 120000), disclosureFeed: async (_client, _symbol, from) => { start = from; return []; } }));
  assert.equal(start.toISOString(), new Date(+NOW - 3600000).toISOString());
});

test('database failure rolls back discoveries and never advances the checkpoint', async t => {
  rows.push(disclosure({ sourceKey: 'bad', publishedAt: 'not-a-timestamp' }));
  await run(t);
  assert.equal((await snapshot(db)).counts.disclosures, 0);
  assert.equal((await db.query("SELECT last_successful_fetch_at FROM collection_state WHERE source='nse'")).rows[0].last_successful_fetch_at, null);
});

test('metadata-only item queues analysis with complete raw input retained', async t => {
  rows = [disclosure({ assets: [] })];
  await run(t);
  const job = (await db.query('SELECT * FROM processing_jobs')).rows[0];
  assert.equal(job.job_type, 'analyse');
  assert.ok(await jobInputIsCurrent(db, job));
  rows[0].rawMetadata.extra = 'new fact';
  await collect(db, files, options({ now: new Date(+NOW + 60000) }));
  assert.equal(await jobInputIsCurrent(db, job), false);
  assert.equal((await db.query('SELECT status FROM processing_jobs WHERE id=$1', [job.id])).rows[0].status, 'superseded');
});

test('missing local files force full download instead of conditional 304', async t => {
  await run(t);
  const asset = (await db.query('SELECT * FROM assets')).rows[0];
  await db.query("UPDATE assets SET etag='old-tag'");
  await files.remove(asset.temporary_file_path);
  await collect(db, files, options({ now: new Date(+NOW + 16 * 60000) }));
  assert.deepEqual(requests.at(-1).headers, {});
  assert.ok(await files.exists(asset.temporary_file_path));
});

test('conditional 304 keeps existing bytes and never creates a duplicate extraction job', async t => {
  await run(t);
  await db.query("UPDATE assets SET etag='tag-1'");
  const client = { async get(_url, headers) {
    assert.equal(headers['If-None-Match'], 'tag-1');
    return { status: 304, body: Buffer.alloc(0), headers: new Headers() };
  } };
  const report = await collect(db, files, options({ now: new Date(+NOW + 16 * 60000), client }));
  assert.equal(report.downloads[0].changed, false);
  assert.equal((await snapshot(db)).counts.processing_jobs, 1);
});

test('metadata changes wait for attachment revalidation before analysing existing extracted content', async t => {
  await run(t);
  await db.query("UPDATE assets SET extraction_status='complete'");
  await db.query("UPDATE processing_jobs SET status='completed'");
  rows[0].rawMetadata.newFact = 'metadata changed';
  // Downloads are disabled, so current attachments have not been revalidated.
  await collect(db, files, options({ now: new Date(+NOW + 16 * 60000), downloadLimit: 0 }));
  assert.equal((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n, 0);
  await collect(db, files, options({ now: new Date(+NOW + 17 * 60000) }));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n), 1);
});

test('HTML masquerading as a PDF stays failed instead of creating extract jobs', async t => {
  body = Buffer.from('<html>Access denied</html>');
  await run(t);
  assert.equal((await db.query('SELECT download_status FROM assets')).rows[0].download_status, 'failed');
  assert.equal((await snapshot(db)).counts.processing_jobs, 0);
});

test('source leases prevent overlapping company fetches and expire after crashes', async t => {
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const company = (await companies(db))[0];
  assert.ok(await claimSource(db, company.id, 'nse', NOW));
  assert.equal(await claimSource(db, company.id, 'nse', NOW), null);
  assert.ok(await claimSource(db, company.id, 'nse', new Date(+NOW + 301000)));
});

test('new attachment invalidates previous jobs and keeps original evidence references', async t => {
  await run(t);
  rows[0].assets = [{ sourceUrl: 'https://nsearchives.nseindia.com/corporate/new.pdf' }];
  rows[0].rawMetadata.attachment = 'new.pdf';
  await collect(db, files, options({ now: new Date(+NOW + 60000) }));
  const assets = (await db.query('SELECT * FROM assets ORDER BY source_url')).rows;
  assert.equal(assets.filter(a => a.is_current).length, 1);
  const old = assets.find(a => !a.is_current);
  assert.equal((await db.query('SELECT status FROM processing_jobs WHERE asset_id=$1', [old.id])).rows[0].status, 'superseded');
});

test('market data stores numbers directly with no LLM jobs, and preserves corrections', async t => {
  rows = [];
  let close = 100;
  const priceFeed = async () => ({ url: 'https://query2.finance.yahoo.com/test',
    corporateActions: { splits: {} }, rows: [{ day: '2026-11-11', values: { close, volume: 1000 } }] });
  await run(t, { prices: true, priceFeed });
  close = 101;
  await collect(db, files, options({ now: new Date(+NOW + 86400000), prices: true, priceFeed }));
  const values = (await db.query("SELECT value,is_current FROM observations WHERE metric='close' ORDER BY revision")).rows;
  assert.deepEqual(values.map(v => [Number(v.value), v.is_current]), [[100, false], [101, true]]);
  assert.equal((await snapshot(db)).counts.processing_jobs, 0);
});

test('all selected companies save prices before NSE discovery; an NSE lease or failure cannot block them',async()=>{
  await setPortfolio(db,['TEST','OTHER']);
  const selected=await companies(db),calls=[];
  await claimSource(db,selected.find(c=>c.nse_symbol==='OTHER').id,'nse',NOW);
  const result=await collect(db,files,options({prices:true,downloadLimit:0,
    priceFeed:async(_client,name)=>{calls.push('price:'+name);return {url:'https://query2.finance.yahoo.com/test',corporateActions:{},rows:[
      {day:'2026-11-10',values:{close:100,volume:900}},{day:'2026-11-11',values:{close:102,volume:1000}}]};},
    disclosureFeed:async()=>{assert.equal(calls.length,2);throw Error('NSE timeout');}}));
  assert.equal(result.status,'partial');
  const list=await watchlist(db);assert.equal(list.length,2);
  for(const c of list){assert.equal(c.market.close,102);assert.equal(c.market.volume,1000);assert.ok(Math.abs(c.market.change_percent-2)<1e-9);assert.equal(c.market_status.state,'available');}
});

test('watchlist exposes price-source failures instead of indefinite waiting and retains the last good price',async()=>{
  rows=[];
  await collect(db,files,options({prices:true,priceFeed:async()=>{throw Error('Yahoo HTTP 429');}}));
  let row=(await watchlist(db))[0];assert.equal(row.market,null);assert.equal(row.market_status.state,'failed');assert.match(row.market_status.error,/429/);
  await collect(db,files,options({prices:true,priceFeed:async()=>({url:'https://query2.finance.yahoo.com/test',rows:[{day:'2026-11-11',values:{close:101,volume:1000}}]})}));
  row=(await watchlist(db))[0];assert.equal(row.market.close,101);assert.equal(row.market_status.state,'available');assert.equal(row.market_status.error,null);
  await collect(db,files,options({now:new Date(+NOW+86400000),prices:true,priceFeed:async()=>{throw Error('Yahoo unavailable');}}));
  row=(await watchlist(db))[0];assert.equal(row.market.close,101);assert.equal(row.market_status.state,'failed');
});

test('NSE parser preserves unknown fields and uses Indian publication timezone', () => {
  const raw = { symbol: 'TEST', seq_id: '123', an_dt: '12-Nov-2026 09:30:00', desc: 'Update',
    attchmntFile: 'https://nsearchives.nseindia.com/test.pdf', unknown: { all: 'retained' } };
  const result = parseDisclosures([raw], 'TEST', 'https://www.nseindia.com/api/test')[0];
  assert.equal(result.publishedAt, '2026-11-12T04:00:00.000Z');
  assert.deepEqual(result.rawMetadata, raw);
  assert.throws(() => parseDisclosures([raw], 'OTHER', 'https://www.nseindia.com/api/test'));
});

test('daily market parser excludes unfinished sessions and missing values', () => {
  const dates = ['2026-11-11T09:15:00+05:30', '2026-11-12T09:15:00+05:30'];
  const result = { meta: { symbol: 'TEST.NS', currency: 'INR', exchangeTimezoneName: 'Asia/Kolkata',
    currentTradingPeriod: { regular: { end: +new Date('2026-11-12T15:30:00+05:30') / 1000 } } },
  timestamp: dates.map(d => +new Date(d) / 1000), indicators: { quote: [{ open: [100,100], high: [110,110], low: [90,90], close: [105,105], volume: [1000,1000] }] } };
  assert.equal(parsePrices({ chart: { result: [result] } }, 'TEST', NOW).rows.length, 1);
  result.indicators.quote[0].close[0] = null;
  assert.throws(() => parsePrices({ chart: { result: [result] } }, 'TEST', NOW));
});

test('authenticated job endpoint rejects absent/wrong secrets; source URLs reject private hosts', () => {
  assert.equal(authorised({ headers: {} }, 'secret'), false);
  assert.equal(authorised({ headers: { authorization: 'Bearer secret' } }, 'secret'), true);
  assert.equal(authorised({ headers: { authorization: 'Bearer secret' } }, ''), false);
  for (const url of ['http://www.nseindia.com/file', 'https://localhost/file', 'https://nseindia.com.evil.example/file', 'https://127.0.0.1/file']) assert.throws(() => validateSourceUrl(url));
});

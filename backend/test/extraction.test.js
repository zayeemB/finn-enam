import { before, after, beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { openDatabase } from '../db.js';
import { localFiles } from '../files.js';
import { collect } from '../collector.js';
import { setPortfolio, jobInputIsCurrent } from '../repository.js';
import { extract } from '../extraction/worker.js';
import { RenderSession } from '../extraction/renderer.js';
import { claimExtraction, savePage } from '../extraction/jobs.js';
import extractHandler from '../../api/extract.js';

const NOW = new Date('2026-11-12T09:00:00Z');
let db, directory, files;
before(async () => { db = await openDatabase({ memory: true, connectionString: '' }); });
after(async () => db.close());
beforeEach(async () => {
  await db.query('TRUNCATE companies,portfolios CASCADE');
  directory = await mkdtemp(join(tmpdir(), 'finn-extract-test-'));
  files = localFiles(directory);
  await setPortfolio(db, ['TEST']);
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

function scanImage() {
  const canvas = createCanvas(400, 500), ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 400, 500);
  ctx.fillStyle = '#172b4d'; ctx.font = '22px sans-serif'; ctx.fillText('Scanned financial statement', 20, 50);
  ctx.fillStyle = '#05a'; ctx.fillRect(30, 100, 90, 220);
  return canvas.toBuffer('image/png');
}

async function fixture({ pages = 2, scan = false, attachment = false } = {}) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = pdf.addPage([400, 500]);
    if (scan && n === pages) {
      const png = await pdf.embedPng(scanImage());
      page.drawImage(png, { x: 0, y: 0, width: 400, height: 500 });
    } else {
      page.drawText(`Complete source text page ${n}`, { x: 25, y: 460, size: 14, font });
      page.drawText('Revenue   EBITDA   PAT', { x: 25, y: 420, size: 12, font });
      page.drawText('1200      180      110', { x: 25, y: 400, size: 12, font });
      // This chart is vector graphics, not text. Its page image must survive.
      page.drawRectangle({ x: 30, y: 100, width: 80, height: 180, color: rgb(0, 0.3, 0.8) });
      page.drawRectangle({ x: 140, y: 100, width: 80, height: 260, color: rgb(0, 0.7, 0.4) });
    }
  }
  if (attachment) await pdf.attach(Buffer.from('Unprocessed embedded content'), 'extra.txt', { mimeType: 'text/plain' });
  return Buffer.from(await pdf.save());
}

async function seed(body, key = 'one', now = NOW) {
  const row = { source: 'nse', sourceKey: key, title: 'Original company disclosure',
    sourceUrl: `https://nsearchives.nseindia.com/${key}.pdf`, publishedAt: now.toISOString(),
    rawMetadata: { unfiltered: 'source metadata', key }, assets: [{ sourceUrl: `https://nsearchives.nseindia.com/${key}.pdf` }] };
  await collect(db, files, { now, prices: false, disclosureFeed: async () => [row],
    client: { get: async () => ({ status: 200, body, headers: new Headers({ 'content-type': 'application/pdf' }) }) } });
  return (await db.query('SELECT * FROM assets WHERE source_url=$1', [row.sourceUrl])).rows[0];
}
const run = (options = {}) => extract(db, files, { clock: () => NOW, ...options });

test('prepares full page text, geometry and chart images; then queues analysis', async () => {
  const original = await fixture();
  const asset = await seed(original);
  const report = await run();
  assert.equal(report.pagesSaved, 2);
  assert.equal(report.jobs[0].status, 'completed');
  const blocks = (await db.query('SELECT * FROM content_blocks ORDER BY sequence')).rows;
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].content.text, /Complete source text page 1/);
  assert.match(blocks[0].content.text, /1200/);
  assert.ok(blocks[0].content.text_items.every(i => Array.isArray(i.transform)));
  assert.equal(blocks[0].content.render_transform.length, 6);
  assert.equal(blocks[0].content.requires_visual_analysis, true);
  const png = await files.get(blocks[0].temporary_image_path);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixel = ctx.getImageData(60, 450, 1, 1).data;
  assert.ok(pixel[2] > pixel[0]); // Blue vector chart bar, absent from extracted text.
  const analysis = (await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.ok(await jobInputIsCurrent(db, analysis));
  assert.equal((await db.query('SELECT extraction_status FROM assets')).rows[0].extraction_status, 'complete');
  assert.deepEqual(await files.get(asset.temporary_file_path), original); // Retained until analysis/cleanup.
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n), 0);
});

test('scanned pages are prepared for vision, not falsely reported as OCR text', async () => {
  await seed(await fixture({ scan: true }));
  await run();
  const scan = (await db.query('SELECT * FROM content_blocks WHERE sequence=2')).rows[0];
  assert.equal(scan.content.text_status, 'none');
  assert.equal(scan.content.text, '');
  assert.equal(scan.content.requires_visual_analysis, true);
  assert.ok(await files.exists(scan.temporary_image_path));
  const metadata = (await db.query('SELECT extraction_metadata FROM assets')).rows[0].extraction_metadata;
  assert.equal(metadata.complete, true);
  assert.equal(metadata.ocr_performed, false);
});

test('page budget yields and resumes, including documents requiring more than five batches', async () => {
  await seed(await fixture({ pages: 6 }));
  for (let n = 1; n <= 6; n++) {
    const result = await run({ pageLimit: 1, clock: () => new Date(+NOW + n * 1000) });
    assert.equal(result.pagesSaved, 1);
    assert.equal(result.jobs[0].pagesPrepared, n);
    assert.equal(result.jobs[0].status, n === 6 ? 'completed' : 'yielded');
    assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n), n === 6 ? 1 : 0);
  }
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks')).rows[0].n), 6);
  const repeated = await run();
  assert.equal(repeated.jobs.length, 0);
});

test('failed page resumes without losing earlier pages or duplicating them', async () => {
  await seed(await fixture());
  const report = await run({ createRenderer() {
    const renderer = new RenderSession();
    return { open: (...args) => renderer.open(...args), close: () => renderer.close(),
      page(n, timeout) { if (n === 2) throw new Error('Temporary render failure'); return renderer.page(n, timeout); } };
  } });
  assert.equal(report.status, 'partial');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks')).rows[0].n), 1);
  assert.equal((await run()).jobs.length, 0); // Backoff is enforced.
  const retried = await run({ clock: () => new Date(+NOW + 61000) });
  assert.equal(retried.pagesSaved, 1);
  assert.equal(retried.jobs[0].status, 'completed');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks')).rows[0].n), 2);
});

test('long documents yield fairly so smaller later disclosures can be prepared', async () => {
  await seed(await fixture({ pages: 4 }), 'long');
  await seed(await fixture({ pages: 1 }), 'short', new Date(+NOW + 1000));
  const first = await run({ pageLimit: 1, clock: () => new Date(+NOW + 2000) });
  assert.equal(first.jobs[0].status, 'yielded');
  const second = await run({ pageLimit: 1, clock: () => new Date(+NOW + 3000) });
  assert.equal(second.jobs[0].status, 'completed');
  assert.equal(second.jobs[0].totalPages, 1);
});

test('parser deadlines terminate rendering and leave work retryable', async () => {
  await seed(await fixture());
  const report = await run({ pageTimeoutMs: 1 });
  assert.equal(report.jobs[0].status, 'failed');
  assert.match(report.jobs[0].error, /timed out/);
  assert.equal((await db.query("SELECT status FROM processing_jobs WHERE job_type='extract'")).rows[0].status, 'failed');
});

test('lost source files request collector re-download rather than network-fetching in the worker', async () => {
  const asset = await seed(await fixture());
  await files.remove(asset.temporary_file_path);
  const result = await run();
  assert.equal(result.jobs[0].status, 'failed');
  const saved = (await db.query('SELECT * FROM assets')).rows[0];
  assert.equal(saved.download_status, 'pending');
  assert.equal(saved.extraction_status, 'failed');
});

test('expired worker cannot commit after another worker reclaims the job', async () => {
  await seed(await fixture());
  const old = await claimExtraction(db, NOW);
  assert.equal(await claimExtraction(db, NOW), null);
  const later = new Date(+NOW + 301000);
  const fresh = await claimExtraction(db, later);
  assert.notEqual(old.lease_token, fresh.lease_token);
  const block = { page: 1, totalPages: 2, imageKey: 'a'.repeat(64), content: { text: 'source' } };
  assert.equal(await savePage(db, old, block, later), false);
  assert.equal(await savePage(db, fresh, block, later), true);
});

test('changed input while rendering cannot publish stale content blocks', async () => {
  await seed(await fixture());
  const result = await run({ createRenderer() {
    const renderer = new RenderSession();
    return { open: (...args) => renderer.open(...args), close: () => renderer.close(),
      async page(...args) {
        const output = await renderer.page(...args);
        await db.query("UPDATE assets SET content_hash='new-input-hash'");
        await db.query("UPDATE processing_jobs SET status='superseded'");
        return output;
      } };
  } });
  assert.equal(result.jobs[0].status, 'superseded_or_lease_lost');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks')).rows[0].n), 0);
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n), 0);
});

test('raster image attachments are preserved for visual analysis', async () => {
  await seed(scanImage());
  const report = await run();
  assert.equal(report.jobs[0].status, 'completed');
  const block = (await db.query('SELECT * FROM content_blocks')).rows[0];
  assert.equal(block.content.text_status, 'none');
  assert.equal(block.content.requires_visual_analysis, true);
  assert.ok(await files.exists(block.temporary_image_path));
});

test('unsupported formats are explicit and the analysis input records that limitation', async () => {
  await seed(Buffer.from('Spreadsheet or audio bytes not supported here'));
  const report = await run();
  assert.equal(report.jobs[0].status, 'unsupported');
  const asset = (await db.query('SELECT * FROM assets')).rows[0];
  assert.equal(asset.extraction_status, 'unsupported');
  assert.ok(asset.extraction_error);
  assert.ok(await files.exists(asset.temporary_file_path));
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n), 1);
});

test('embedded attachments block complete coverage instead of disappearing', async () => {
  await seed(await fixture({ pages: 1, attachment: true }));
  const report = await run();
  assert.equal(report.jobs[0].status, 'partial');
  const asset = (await db.query('SELECT * FROM assets')).rows[0];
  assert.equal(asset.extraction_metadata.embeddedAttachments[0].filename, 'extra.txt');
  assert.equal(asset.extraction_status, 'partial');
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n), 0);
});

test('HTTP extraction route rejects unauthorised calls before opening storage', async () => {
  const response = { code: 0, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { return body; } };
  await extractHandler({ method: 'POST', headers: {} }, response);
  assert.equal(response.code, 401);
});

test('large PDFs index all text without rendering every page and can be loaded for selected analysis',async()=>{
 const {loadInput}=await import('../analysis/input.js');
 const data=await fixture({pages:30});
 await seed(data);
 const result=await extract(db,files,{clock:()=>NOW,budgetMs:45000,pageLimit:10});
 assert.equal(result.jobs[0].status,'completed');
 const pages=(await db.query('SELECT * FROM content_blocks')).rows;
 assert.equal(pages.length,30);assert.ok(pages.every(p=>p.content.text_indexed));
 assert.ok(pages.every(p=>!p.temporary_image_path));
 const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
 const input=await loadInput(db,job);assert.equal(input.blocks.length,30);
 const {analyse}=await import('../analysis/worker.js');let calls=0;
 const model={model:'mock',async generate(request){calls++;const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1));return {data:{covered_block_ids:request.stage==='page_extraction'?source.pages.map(p=>p.block_id):source.findings.flatMap(f=>f.covered_block_ids),developments:[],limitations:[]}};}};
 const analysed=await analyse(db,files,{model,clock:()=>NOW,budgetMs:45000,callLimit:2});
 assert.equal(analysed.jobs[0].status,'completed');assert.equal(calls,2);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks WHERE temporary_image_path IS NOT NULL')).rows[0].n),1);
});

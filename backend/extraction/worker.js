import { hash } from '../sources.js';
import { RenderSession } from './renderer.js';
import { PROCESSOR, claimExtraction, resumePage, savePage, finishExtraction, failExtraction } from './jobs.js';

function sanitise(value) {
  let replacements = 0;
  const content = JSON.parse(JSON.stringify(value, (_key, v) => {
    if (typeof v !== 'string') return v;
    replacements += (v.match(/\u0000/g) || []).length;
    return v.replace(/\u0000/g, '\uFFFD').toWellFormed();
  }));
  if (replacements) content.encoding_warnings = { nul_characters_replaced: replacements };
  return content;
}

export async function extract(db, files, { budgetMs = 45000, pageLimit = 10, jobLimit = 3,
  pageTimeoutMs = 20000, scale = 1.5, maxPixels = 6000000, clock = () => new Date(),
  createRenderer = () => new RenderSession({ timeoutMs: pageTimeoutMs }) } = {}) {
  if (![budgetMs, pageTimeoutMs, scale, maxPixels].every(n => Number.isFinite(n) && n > 0) ||
    ![pageLimit, jobLimit].every(n => Number.isSafeInteger(n) && n >= 1)) throw new Error('Invalid extraction limits');
  const deadline = Date.now() + budgetMs;
  const report = { startedAt: clock().toISOString(), status: 'ok', pagesSaved: 0, jobs: [] };
  for (let i = 0; i < jobLimit && report.pagesSaved < pageLimit && Date.now() + 1000 < deadline; i++) {
    const job = await claimExtraction(db, clock());
    if (!job) break;
    const result = { jobId: job.id, assetId: job.asset_id };
    report.jobs.push(result);
    let renderer;
    try {
      const asset = (await db.query('SELECT * FROM assets WHERE id=$1', [job.asset_id])).rows[0];
      let bytes;
      try {
        if (asset.storage_backend !== files.backend || !asset.temporary_file_path) throw new Error('Asset storage backend/path unavailable');
        bytes = await files.get(asset.temporary_file_path);
      } catch (error) { error.missingFile = true; throw error; }
      if (bytes.length > 60 * 1024 * 1024) throw new Error('Asset exceeds 60 MiB extraction limit');
      if (hash(bytes) !== job.input_hash) throw Object.assign(new Error('Saved asset checksum mismatch; collector must download it again'), { missingFile: true });
      renderer = createRenderer();
      const meta = await renderer.open(bytes, { scale, maxPixels }, Math.min(pageTimeoutMs, Math.max(1, deadline - Date.now())));
      let page = await resumePage(db, files, job, clock());
      if (page === null) { result.status = 'superseded_or_lease_lost'; continue; }
      let lost = false;
      for (; page <= meta.totalPages && report.pagesSaved < pageLimit && Date.now() + 500 < deadline; page++) {
        const prepared = await renderer.page(page, Math.min(pageTimeoutMs, Math.max(1, deadline - Date.now())));
        const image = Buffer.from(prepared.image);
        const imageKey = await files.put(image, { contentType: 'image/png' });
        const content = sanitise({ text: prepared.text, text_items: prepared.items, annotations: prepared.annotations,
          text_status: prepared.textError ? 'failed' : prepared.text.trim() ? 'available' : 'none',
          text_error: prepared.textError, requires_visual_analysis: true,
          image_storage_backend: files.backend, image_media_type: 'image/png', image_sha256: hash(image),
          rendered_width: prepared.width, rendered_height: prepared.height,
          source_width: prepared.sourceWidth, source_height: prepared.sourceHeight,
          page_rotation: prepared.rotation, render_transform: prepared.renderTransform,
          coordinates: 'text item transforms use PDF page coordinates; image dimensions are pixels',
          structured_tables: 'not inferred; text geometry and the full-page image preserve table context' });
        const saved = await savePage(db, job, { page, totalPages: meta.totalPages, imageKey, content }, clock());
        if (!saved) { lost = true; break; }
        report.pagesSaved++;
      }
      if (lost) { result.status = 'superseded_or_lease_lost'; continue; }
      const allPages = page > meta.totalPages;
      const hasEmbedded = (meta.embeddedAttachments || []).length > 0;
      const output = { processor: PROCESSOR, format: meta.format, totalPages: meta.totalPages,
        pagesPrepared: Math.min(page - 1, meta.totalPages), complete: allPages && !hasEmbedded,
        yielded: !allPages, requires_visual_analysis: true, ocr_performed: false,
        embeddedAttachments: meta.embeddedAttachments || [],
        error: allPages && hasEmbedded ? 'Embedded attachments are retained in the original PDF but require separate extraction' : null };
      const committed = await finishExtraction(db, job, output, clock());
      result.status = committed ? output.yielded ? 'yielded' : output.complete ? 'completed' : 'partial' : 'superseded_or_lease_lost';
      result.pagesPrepared = output.pagesPrepared; result.totalPages = output.totalPages;
      if (result.status === 'partial') report.status = 'partial';
      if (output.yielded) break; // Avoid immediately re-claiming a large document in this invocation.
    } catch (error) {
      if (error.unsupported) {
        await finishExtraction(db, job, { processor: PROCESSOR, unsupported: true, complete: false,
          error: error.message, requires_visual_analysis: false }, clock());
        result.status = 'unsupported'; result.error = error.message; report.status = 'partial';
      } else {
        await failExtraction(db, job, error, clock(), { missingFile: error.missingFile === true });
        result.status = 'failed'; result.error = error.message; report.status = 'partial';
      }
    } finally { if (renderer) await renderer.close(); }
  }
  report.remainingJobs = Number((await db.query("SELECT count(*) AS count FROM processing_jobs WHERE job_type='extract' AND status IN ('queued','running','failed')")).rows[0].count);
  report.finishedAt = clock().toISOString();
  return report;
}

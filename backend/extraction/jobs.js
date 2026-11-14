import { randomUUID } from 'node:crypto';
import { queueAnalysis } from '../repository.js';

export const PROCESSOR = 'pdfjs-pages-v1';
const LEASE_MS = 300000;

export async function claimExtraction(db, now, retryLimit = 5) {
  return db.transaction(async tx => {
    // A stopped collector might leave stale work; never render it as the current input.
    await tx.query(`UPDATE processing_jobs j SET status='superseded',lease_token=NULL,lease_expires_at=NULL
      WHERE j.job_type='extract' AND j.status IN ('queued','failed')
      AND NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=j.asset_id AND a.is_current AND a.content_hash=j.input_hash)`);
    const job = (await tx.query(`SELECT j.* FROM processing_jobs j JOIN assets a ON a.id=j.asset_id
      WHERE j.job_type='extract' AND a.is_current AND a.content_hash=j.input_hash AND a.download_status='downloaded'
      AND j.failure_count<$2 AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=$1)
      AND (j.status IN ('queued','failed') OR (j.status='running' AND j.lease_expires_at<=$1))
      ORDER BY coalesce(j.started_at,j.created_at),j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`, [now, retryLimit])).rows[0];
    if (!job) return null;
    const token = randomUUID();
    await tx.query(`UPDATE processing_jobs SET status='running',lease_token=$2,lease_expires_at=$3,
      attempts=attempts+1,started_at=$4,processor_version=$5,error=NULL WHERE id=$1`,
    [job.id, token, new Date(+now + LEASE_MS), now, PROCESSOR]);
    return { ...job, status: 'running', lease_token: token };
  });
}

// Always lock asset before job, matching the collector's invalidation order.
async function owned(tx, job, now) {
  const asset = (await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [job.asset_id])).rows[0];
  const current = (await tx.query('SELECT * FROM processing_jobs WHERE id=$1 FOR UPDATE', [job.id])).rows[0];
  if (!current || current.status !== 'running' || current.lease_token !== job.lease_token || +new Date(current.lease_expires_at) <= +now) return null;
  if (!asset?.is_current || asset.content_hash !== job.input_hash) {
    await tx.query("UPDATE processing_jobs SET status='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1", [job.id]);
    return null;
  }
  return { asset, current };
}

export async function resumePage(db, files, job, now) {
  const rows = (await db.query(`SELECT sequence,temporary_image_path,content->>'image_storage_backend' AS image_backend FROM content_blocks
    WHERE asset_id=$1 AND asset_content_hash=$2 AND processor_version=$3 ORDER BY sequence`,
  [job.asset_id, job.input_hash, PROCESSOR])).rows;
  let last = 0;
  for (const row of rows) { if (row.sequence !== last + 1 || !row.temporary_image_path || row.image_backend !== files.backend) break; last++; }
  if (last && !await files.exists(rows[last - 1].temporary_image_path)) {
    // Source bytes survive; a lost derived cache can be rebuilt. Citation snapshots are independent.
    const cleared = await db.transaction(async tx => {
      if (!await owned(tx, job, now)) return false;
      await tx.query('DELETE FROM content_blocks WHERE asset_id=$1 AND asset_content_hash=$2 AND processor_version=$3', [job.asset_id, job.input_hash, PROCESSOR]);
      return true;
    });
    if (!cleared) return null;
    return 1;
  }
  return last + 1;
}

export async function savePage(db, job, block, now) {
  return db.transaction(async tx => {
    const owner = await owned(tx, job, now);
    if (!owner) return false;
    await tx.query(`INSERT INTO content_blocks(id,asset_id,asset_content_hash,block_type,location,sequence,content,
      temporary_image_path,extraction_method,status,processor_version)
      VALUES ($1,$2,$3,'page',$4,$5,$6,$7,'pdfjs_text_and_full_page_image','ready_for_analysis',$8)
      ON CONFLICT(asset_id,asset_content_hash,processor_version,sequence) DO UPDATE SET
      location=excluded.location,content=excluded.content,temporary_image_path=excluded.temporary_image_path,
      status=excluded.status,error=NULL`,
    [randomUUID(), job.asset_id, job.input_hash, JSON.stringify({ page: block.page }), block.page,
      JSON.stringify(block.content), block.imageKey, PROCESSOR]);
    await tx.query(`UPDATE processing_jobs SET output=$2,lease_expires_at=$3,failure_count=0 WHERE id=$1`,
    [job.id, JSON.stringify({ lastPage: block.page, totalPages: block.totalPages, processor: PROCESSOR }), new Date(+now + LEASE_MS)]);
    await tx.query("UPDATE assets SET extraction_status='partial',extraction_error=NULL WHERE id=$1", [job.asset_id]);
    return true;
  });
}

export async function finishExtraction(db, job, output, now) {
  return db.transaction(async tx => {
    if (!await owned(tx, job, now)) return false;
    const status = output.unsupported ? 'unsupported' : output.complete ? 'complete' : 'partial';
    await tx.query(`UPDATE assets SET extraction_status=$2,extraction_metadata=$3,extraction_processor_version=$4,
      extraction_error=$5 WHERE id=$1`, [job.asset_id, status, JSON.stringify(output), PROCESSOR, output.error || null]);
    await tx.query(`UPDATE processing_jobs SET status=$2,output=$3,completed_at=$4,error=$5,
      lease_token=NULL,lease_expires_at=NULL,next_attempt_at=NULL,failure_count=0 WHERE id=$1`,
    [job.id, output.yielded ? 'queued' : 'completed', JSON.stringify(output), output.yielded ? null : now, output.error || null]);
    if (status === 'complete' || status === 'unsupported') await queueAnalysis(tx, job.disclosure_id, now);
    return true;
  });
}

export async function failExtraction(db, job, error, now, { missingFile = false } = {}) {
  return db.transaction(async tx => {
    const owner = await owned(tx, job, now);
    if (!owner) return false;
    const failures = owner.current.failure_count + 1;
    const retry = new Date(+now + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6)));
    await tx.query(`UPDATE processing_jobs SET status='failed',error=$2,failure_count=$3,next_attempt_at=$4,
      lease_token=NULL,lease_expires_at=NULL WHERE id=$1`, [job.id, error.message, failures, retry]);
    await tx.query(`UPDATE assets SET extraction_status='failed',extraction_error=$2,
      download_status=CASE WHEN $3 THEN 'pending' ELSE download_status END,
      next_retry_at=CASE WHEN $3 THEN NULL ELSE next_retry_at END WHERE id=$1`, [job.asset_id, error.message, missingFile]);
    return true;
  });
}

export async function retryFailedExtractions(db) {
  return (await db.query(`UPDATE processing_jobs SET failure_count=0,next_attempt_at=NULL WHERE
    job_type='extract' AND status='failed' RETURNING id`)).rows.length;
}

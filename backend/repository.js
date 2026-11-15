import { randomUUID } from 'node:crypto';
import { inputHash, symbol } from './sources.js';
export const PORTFOLIO = '00000000-0000-4000-8000-000000000001';
const json = value => JSON.stringify(value);

export async function setPortfolio(db, symbols) {
  symbols = [...new Set(symbols.map(symbol))];
  await db.transaction(async tx => {
    await tx.query('INSERT INTO portfolios(id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [PORTFOLIO, 'Demo portfolio']);
    for (const [type, settings] of Object.entries({ price_move: { percent: 5 }, volume_spike: { multiple: 2, sessions: 20 },
      announcement: { categories: ['results','M&A','management_change','litigation','credit_rating','fund_raise'] } })) {
      await tx.query('INSERT INTO alert_rules(id,portfolio_id,rule_type,settings) VALUES ($1,$2,$3,$4) ON CONFLICT(portfolio_id,rule_type) DO NOTHING', [randomUUID(), PORTFOLIO, type, JSON.stringify(settings)]);
    }
    await tx.query('DELETE FROM portfolio_companies WHERE portfolio_id=$1', [PORTFOLIO]);
    for (const name of symbols) {
      const { rows } = await tx.query('INSERT INTO companies(id,nse_symbol,name) VALUES ($1,$2,$2) ON CONFLICT(nse_symbol) DO UPDATE SET nse_symbol=excluded.nse_symbol RETURNING id', [randomUUID(), name]);
      await tx.query('INSERT INTO portfolio_companies(portfolio_id,company_id) VALUES ($1,$2)', [PORTFOLIO, rows[0].id]);
    }
  });
}
export async function companies(db) {
  return (await db.query(`SELECT c.*,s.last_successful_fetch_at,s.last_attempt_at FROM companies c
    JOIN portfolio_companies p ON p.company_id=c.id LEFT JOIN collection_state s ON s.company_id=c.id AND s.source='nse'
    WHERE p.portfolio_id=$1 ORDER BY s.last_attempt_at NULLS FIRST,c.nse_symbol`, [PORTFOLIO])).rows;
}
export async function claimSource(db, companyId, source, now) {
  await db.query('INSERT INTO collection_state(company_id,source) VALUES ($1,$2) ON CONFLICT DO NOTHING', [companyId, source]);
  const token = randomUUID();
  const { rows } = await db.query(`UPDATE collection_state SET lease_token=$3,lease_expires_at=$4,last_attempt_at=$5
    WHERE company_id=$1 AND source=$2 AND (lease_expires_at IS NULL OR lease_expires_at<=$5)
    RETURNING *`, [companyId, source, token, new Date(+now + 300000), now]);
  return rows[0] || null;
}
export async function failSource(db, companyId, source, token, error) {
  await db.query('UPDATE collection_state SET last_error=$4,lease_token=NULL,lease_expires_at=NULL WHERE company_id=$1 AND source=$2 AND lease_token=$3', [companyId, source, token, String(error.message || error)]);
}

export async function supersedeAnalysis(tx, disclosureId) {
  await tx.query("UPDATE processing_jobs SET status='superseded' WHERE disclosure_id=$1 AND job_type='analyse' AND status IN ('queued','running','failed')", [disclosureId]);
}
export async function queueAnalysis(tx, disclosureId, now) {
  const disclosure = (await tx.query('SELECT * FROM disclosures WHERE id=$1', [disclosureId])).rows[0];
  if(disclosure.collection_mode==='research') return null;
  const assets = (await tx.query('SELECT * FROM assets WHERE disclosure_id=$1 AND is_current ORDER BY source_url', [disclosureId])).rows;
  if (assets.some(a => a.download_status !== 'unsupported' && (a.download_status !== 'downloaded' ||
    !['complete','unsupported'].includes(a.extraction_status) || !a.checked_at || +new Date(a.checked_at) < +new Date(disclosure.updated_at)))) return null;
  const hash = inputHash({ metadata: disclosure.metadata_hash,
    assets: assets.map(a => [a.id, a.content_hash, a.download_status, a.extraction_status, a.extraction_processor_version]), processor: 'analyse-v1' });
  const latest = (await tx.query("SELECT input_hash FROM processing_jobs WHERE disclosure_id=$1 AND job_type='analyse' ORDER BY created_at DESC LIMIT 1", [disclosureId])).rows[0];
  await tx.query(`INSERT INTO processing_jobs(id,job_type,disclosure_id,input_hash,created_at)
    VALUES ($1,'analyse',$2,$3,$4) ON CONFLICT DO NOTHING`, [randomUUID(), disclosureId, hash, now]);
  await tx.query("UPDATE processing_jobs SET status='queued',error=NULL,next_attempt_at=NULL WHERE disclosure_id=$1 AND job_type='analyse' AND input_hash=$2 AND status='superseded'", [disclosureId,hash]);
  if (latest && latest.input_hash !== hash) await tx.query(`UPDATE processing_jobs SET status='queued',output=NULL,
    error=NULL,attempts=0,next_attempt_at=NULL,lease_expires_at=NULL,started_at=NULL,completed_at=NULL,created_at=$3
    WHERE disclosure_id=$1 AND job_type='analyse' AND input_hash=$2 AND status IN ('completed','superseded','failed')`,
  [disclosureId, hash, now]);
  return hash;
}

export async function saveDisclosures(db, companyId, lease, rows, now) {
  return db.transaction(async tx => {
    const owned = (await tx.query("SELECT lease_token FROM collection_state WHERE company_id=$1 AND source='nse' FOR UPDATE", [companyId])).rows[0];
    if (owned?.lease_token !== lease.lease_token) throw new Error('Collection lease was lost; checkpoint not advanced');
    let added = 0, changed = 0;
    for (const row of rows) {
      const previous = (await tx.query('SELECT * FROM disclosures WHERE company_id=$1 AND source=$2 AND source_key=$3', [companyId, row.source, row.sourceKey])).rows[0];
      const metadataHash = inputHash(row.rawMetadata);
      const id = previous?.id || randomUUID();
      const dirty = !previous || previous.metadata_hash !== metadataHash;
      if (!previous) added++;
      else if (dirty) changed++;
      await tx.query(`INSERT INTO disclosures(id,company_id,source,source_key,title,source_url,published_at,first_seen_at,raw_metadata,metadata_hash,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8) ON CONFLICT(company_id,source,source_key)
        DO UPDATE SET title=excluded.title,source_url=excluded.source_url,published_at=excluded.published_at,
        raw_metadata=excluded.raw_metadata,metadata_hash=excluded.metadata_hash,
        updated_at=CASE WHEN disclosures.metadata_hash<>excluded.metadata_hash THEN excluded.updated_at ELSE disclosures.updated_at END`,
      [id, companyId, row.source, row.sourceKey, row.title, row.sourceUrl, row.publishedAt, now, json(row.rawMetadata), metadataHash]);
      if (dirty) await supersedeAnalysis(tx, id);
      await tx.query('UPDATE assets SET is_current=false WHERE disclosure_id=$1', [id]);
      for (const asset of row.assets) {
        await tx.query(`INSERT INTO assets(id,disclosure_id,source_url,last_seen_at)
          VALUES ($1,$2,$3,$4) ON CONFLICT(disclosure_id,source_url) DO UPDATE SET last_seen_at=excluded.last_seen_at,is_current=true`,
        [randomUUID(), id, asset.sourceUrl, now]);
      }
      await tx.query(`UPDATE processing_jobs SET status='superseded' WHERE disclosure_id=$1
        AND asset_id IN (SELECT id FROM assets WHERE disclosure_id=$1 AND NOT is_current)
        AND status IN ('queued','running','failed')`, [id]);
      // Metadata-only disclosures can go straight to analysis. Assets wait for extraction.
      await queueAnalysis(tx, id, now);
    }
    await tx.query(`UPDATE collection_state SET last_successful_fetch_at=$3,last_error=NULL,lease_token=NULL,lease_expires_at=NULL
      WHERE company_id=$1 AND source='nse' AND lease_token=$2`, [companyId, lease.lease_token, now]);
    return { added, changed };
  });
}

export async function claimAsset(db, now, { revalidateMinutes = 15, force = false } = {}) {
  return db.transaction(async tx => {
    const rows = (await tx.query(`SELECT a.* FROM assets a JOIN disclosures d ON d.id=a.disclosure_id
      WHERE a.is_current AND a.download_status<>'unsupported'
      AND EXISTS(SELECT 1 FROM portfolio_companies p WHERE p.company_id=d.company_id AND p.portfolio_id=$1)
      AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=$2)
      AND (a.next_retry_at IS NULL OR a.next_retry_at<=$2)
      AND (a.download_status IN ('pending','failed') OR
        (a.download_status='downloaded' AND (a.checked_at IS NULL OR a.checked_at<$3) AND (a.last_seen_at>a.checked_at OR $4)))
      ORDER BY CASE WHEN a.download_status='pending' THEN 0 WHEN a.download_status='failed' THEN 1 ELSE 2 END,
      a.download_attempts,a.checked_at NULLS FIRST LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
    [PORTFOLIO, now, new Date(+now - revalidateMinutes * 60000), force])).rows;
    if (!rows[0]) return null;
    const token = randomUUID();
    await tx.query('UPDATE assets SET lease_token=$2,lease_expires_at=$3 WHERE id=$1', [rows[0].id, token, new Date(+now + 300000)]);
    return { ...rows[0], lease_token: token };
  });
}

export async function assetFailed(db, asset, error, now) {
  const delay = Math.min(3600000, 60000 * 2 ** Math.min(asset.download_attempts, 6));
  await db.query(`UPDATE assets SET download_status='failed',download_attempts=download_attempts+1,
    next_retry_at=$3,download_error=$4,checked_at=$5,lease_token=NULL,lease_expires_at=NULL
    WHERE id=$1 AND lease_token=$2`, [asset.id, asset.lease_token, new Date(+now + delay), String(error.message || error), now]);
}

export async function saveAsset(db, asset, result, now) {
  return db.transaction(async tx => {
    const current = (await tx.query('SELECT * FROM assets WHERE id=$1 FOR UPDATE', [asset.id])).rows[0];
    if (current?.lease_token !== asset.lease_token) throw new Error('Asset lease lost');
    const changed = current.content_hash !== result.contentHash;
    if (changed) {
      await supersedeAnalysis(tx, asset.disclosure_id);
      await tx.query("UPDATE processing_jobs SET status='superseded' WHERE asset_id=$1 AND status IN ('queued','running','failed')", [asset.id]);
    }
    await tx.query(`UPDATE assets SET content_hash=$3,byte_size=$4,temporary_file_path=$5,storage_backend=$6,
      filename=$7,media_type=$8,download_status='downloaded',download_attempts=download_attempts+1,
      next_retry_at=NULL,download_error=NULL,downloaded_at=$9,checked_at=$9,etag=$10,last_modified=$11,
      extraction_status=CASE WHEN $12 THEN 'pending' ELSE extraction_status END,
      extraction_error=CASE WHEN $12 THEN NULL ELSE extraction_error END,
      extraction_metadata=CASE WHEN $12 THEN NULL ELSE extraction_metadata END,
      extraction_processor_version=CASE WHEN $12 THEN NULL ELSE extraction_processor_version END,
      lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2`,
    [asset.id, asset.lease_token, result.contentHash, result.size, result.key, result.backend,
      result.filename, result.mediaType, now, result.etag || null, result.lastModified || null, changed]);
    if (changed || current.extraction_status !== 'complete') await tx.query(`INSERT INTO processing_jobs
      (id,job_type,disclosure_id,asset_id,input_hash,created_at) VALUES ($1,'extract',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [randomUUID(), asset.disclosure_id, asset.id, result.contentHash, now]);
    if (changed) await tx.query(`UPDATE processing_jobs SET status='queued',output=NULL,error=NULL,
      attempts=0,next_attempt_at=NULL,started_at=NULL,completed_at=NULL,lease_expires_at=NULL
      WHERE asset_id=$1 AND input_hash=$2 AND status IN ('superseded','completed','failed')`, [asset.id, result.contentHash]);
    await queueAnalysis(tx, asset.disclosure_id, now);
    // No content deletion/expiry until extraction AND analysis have completed.
    return { changed, assetId: asset.id };
  });
}

export async function jobInputIsCurrent(db, job) {
  if (job.job_type === 'extract') {
    const asset = (await db.query('SELECT * FROM assets WHERE id=$1', [job.asset_id])).rows[0];
    return !!asset && asset.is_current && asset.download_status === 'downloaded' && asset.content_hash === job.input_hash;
  }
  const disclosure = (await db.query('SELECT * FROM disclosures WHERE id=$1', [job.disclosure_id])).rows[0];
  if (!disclosure) return false;
  const assets = (await db.query('SELECT * FROM assets WHERE disclosure_id=$1 AND is_current ORDER BY source_url', [disclosure.id])).rows;
  return inputHash({ metadata: disclosure.metadata_hash,
    assets: assets.map(a => [a.id, a.content_hash, a.download_status, a.extraction_status, a.extraction_processor_version]), processor: 'analyse-v1' }) === job.input_hash;
}

export async function snapshot(db) {
  const tables = ['companies', 'disclosures', 'assets', 'content_blocks', 'processing_jobs', 'analysis_batches', 'observations', 'events','event_evidence','alerts'];
  const counts = {};
  for (const table of tables) counts[table] = Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  return { counts, collection: (await db.query('SELECT c.nse_symbol,s.* FROM collection_state s JOIN companies c ON c.id=s.company_id ORDER BY c.nse_symbol,s.source')).rows,
    jobs: (await db.query('SELECT job_type,status,count(*) AS count FROM processing_jobs GROUP BY job_type,status')).rows,
    extraction: (await db.query('SELECT extraction_status,count(*) AS count FROM assets GROUP BY extraction_status')).rows,
    processingErrors: (await db.query("SELECT id,job_type,status,error,error_kind,failure_count,next_attempt_at,output->>'quota_retry_at' AS quota_retry_at FROM processing_jobs WHERE error IS NOT NULL ORDER BY created_at DESC LIMIT 10")).rows };
}

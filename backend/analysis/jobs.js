import { randomUUID } from 'node:crypto';
import { jobInputIsCurrent } from '../repository.js';
import { PROCESSOR, PROMPT_VERSION } from './schema.js';

export async function claimAnalysis(db, now, model) {
  return db.transaction(async tx => {
    const job = (await tx.query(`SELECT * FROM processing_jobs WHERE job_type='analyse'
      AND (failure_count<5 OR error_kind='provider_transient') AND coalesce(error_kind,'') NOT IN ('configuration','quota_limit')
      AND (next_attempt_at IS NULL OR next_attempt_at<=$1)
      AND (status IN ('queued','failed') OR (status='running' AND lease_expires_at<=$1))
      ORDER BY coalesce(started_at,created_at),id LIMIT 1 FOR UPDATE SKIP LOCKED`, [now])).rows[0];
    if (!job) return null;
    if (!await jobInputIsCurrent(tx,job)) {
      await tx.query("UPDATE processing_jobs SET status='superseded' WHERE id=$1", [job.id]);
      return { stale:true,id:job.id };
    }
    const token=randomUUID();
    await tx.query(`UPDATE processing_jobs SET status='running',lease_token=$2,lease_expires_at=$3,
      attempts=attempts+1,started_at=$4,processor_version=$5,prompt_version=$6,model=$7,error=NULL WHERE id=$1`,
    [job.id,token,new Date(+now+300000),now,PROCESSOR,PROMPT_VERSION,model]);
    return { ...job,lease_token:token,model,prompt_version:PROMPT_VERSION };
  });
}

export async function ownAnalysis(tx,job,now) {
  const disclosure=(await tx.query('SELECT * FROM disclosures WHERE id=$1 FOR UPDATE',[job.disclosure_id])).rows[0];
  await tx.query('SELECT id FROM assets WHERE disclosure_id=$1 ORDER BY id FOR UPDATE',[job.disclosure_id]);
  const current=(await tx.query('SELECT * FROM processing_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if (!current || current.status!=='running' || current.lease_token!==job.lease_token || +new Date(current.lease_expires_at)<=+now) return null;
  if (!await jobInputIsCurrent(tx,job)) {
    await tx.query("UPDATE processing_jobs SET status='superseded',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]);
    return null;
  }
  return { disclosure,current };
}

export async function saveBatch(db,job,{key,stage,data,usage,model=job.model},now) {
  return db.transaction(async tx=>{
    if (!await ownAnalysis(tx,job,now)) return false;
    await tx.query(`INSERT INTO analysis_batches(id,job_id,cache_key,input_hash,stage,model,prompt_version,output,usage,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(job_id,cache_key) DO NOTHING`,
    [randomUUID(),job.id,key,job.input_hash,stage,model,PROMPT_VERSION,JSON.stringify(data),JSON.stringify(usage),now]);
    await tx.query(`UPDATE processing_jobs SET output=$2,lease_expires_at=$3,failure_count=0 WHERE id=$1`,
    [job.id,JSON.stringify({stage,last_cached_batch:key}),new Date(+now+300000)]);
    await tx.query('UPDATE processing_jobs SET error_kind=NULL WHERE id=$1',[job.id]);
    return true;
  });
}
export async function renewAnalysis(db,job,now,leaseMs) {
  return db.transaction(async tx=>{
    if (!await ownAnalysis(tx,job,now)) return false;
    await tx.query('UPDATE processing_jobs SET lease_expires_at=$2 WHERE id=$1',[job.id,new Date(+now+leaseMs)]);
    return true;
  });
}
export async function yieldAnalysis(db,job,now) {
  return db.transaction(async tx=>{
    if (!await ownAnalysis(tx,job,now)) return false;
    await tx.query("UPDATE processing_jobs SET status='queued',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]);
    return true;
  });
}
export async function failAnalysis(db,job,error,now) {
  return db.transaction(async tx=>{
    const owned=await ownAnalysis(tx,job,now);
    if (!owned) return false;
    const failures=owned.current.failure_count+1;
    const transient=error.retryable===true;
    const configuration=error.configuration===true || [400,401,402,403,404].includes(error.status);
    const quota=!configuration&&(error.quotaLimited||error.status===429);
    const kind=quota?'quota_limit':configuration?'configuration':transient?'provider_transient':'processing';
    const jitter=transient?Math.floor(Math.random()*1000):0;
    const wait=Math.max(error.retryAfterMs || 0,Math.min(3600000,60000*2**Math.min(failures-1,6)+jitter));
    await tx.query(`UPDATE processing_jobs SET status='failed',error=$2,failure_count=$3,next_attempt_at=$4,error_kind=$5,
      lease_token=NULL,lease_expires_at=NULL,output=CASE WHEN $5='quota_limit' THEN coalesce(output,'{}'::jsonb)||jsonb_build_object('quota_retry_at',$6::timestamptz) ELSE output END WHERE id=$1`,[job.id,error.message,failures,configuration||quota?null:new Date(+now+wait),kind,new Date(+now+(error.quotaRetryAfterMs||wait))]);
    if (!configuration && !error.modelScoped && (transient || error.status===429)) await tx.query(`INSERT INTO provider_backoff VALUES ('gemini',$1,$2)
      ON CONFLICT(provider) DO UPDATE SET retry_after=greatest(provider_backoff.retry_after,excluded.retry_after),reason=excluded.reason`,
    [new Date(+now+wait),error.status===429?'Provider rate limit':'Provider temporarily unavailable']);
    return true;
  });
}

export async function recoverImages(db,job,asset,now) {
  return db.transaction(async tx=>{
    if (!await ownAnalysis(tx,job,now)) return false;
    await tx.query('DELETE FROM content_blocks WHERE asset_id=$1 AND asset_content_hash=$2',[asset.id,asset.content_hash]);
    await tx.query("UPDATE assets SET extraction_status='pending',extraction_error='Derived images missing; regeneration requested' WHERE id=$1",[asset.id]);
    await tx.query(`UPDATE processing_jobs SET status='queued',next_attempt_at=NULL,failure_count=0,
      lease_token=NULL,lease_expires_at=NULL,completed_at=NULL WHERE asset_id=$1 AND job_type='extract' AND input_hash=$2`,[asset.id,asset.content_hash]);
    await tx.query("UPDATE processing_jobs SET status='superseded',error='Waiting for regenerated page images',lease_token=NULL,lease_expires_at=NULL WHERE id=$1",[job.id]);
    return true;
  });
}

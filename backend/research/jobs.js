import {randomUUID} from 'node:crypto';
import {symbol} from '../sources.js';
import {PROCESSOR} from '../extraction/jobs.js';
import {INDEX_VERSION,OVERVIEW_QUESTION} from './brief.js';

export async function createResearch(db,{symbol:name,question,source_policy='primary',annual_reports,transcripts},now=new Date()) {
  name=symbol(name);question=question?.trim() || OVERVIEW_QUESTION;
  if(!question || question.length>2000 || !['primary','assignment'].includes(source_policy) ||
    (annual_reports!==undefined&&(!Number.isInteger(annual_reports)||annual_reports<1||annual_reports>3)) ||
    (transcripts!==undefined&&(!Number.isInteger(transcripts)||transcripts<1||transcripts>4))) throw Object.assign(new Error('Invalid research request'),{status:400});
  return db.transaction(async tx=>{
    // Serialize admission, including requests for different companies.
    await tx.query("SELECT id FROM portfolios WHERE id='00000000-0000-4000-8000-000000000001' FOR UPDATE");
    const company=(await tx.query('INSERT INTO companies(id,nse_symbol,name) VALUES ($1,$2,$2) ON CONFLICT(nse_symbol) DO UPDATE SET nse_symbol=excluded.nse_symbol RETURNING *',[randomUUID(),name])).rows[0];
    // Legacy document counts are accepted but no longer constrain source discovery.
    const options={source_policy,source_selection:'adaptive-v1'};
    const existing=(await tx.query("SELECT * FROM research_jobs WHERE company_id=$1 AND question=$2 AND options @> $3::jsonb AND status IN ('queued','running','waiting') ORDER BY created_at DESC LIMIT 1",[company.id,question,JSON.stringify(options)])).rows[0];
    if(existing) return {id:existing.id,status:existing.status};
    if(Number((await tx.query("SELECT count(*) AS n FROM research_jobs WHERE status IN ('queued','running','waiting')")).rows[0].n)>=3) throw Object.assign(new Error('Three research jobs are already active; let one finish first'),{status:409});
    const row=(await tx.query("INSERT INTO research_jobs(id,company_id,question,status,progress,options,created_at) VALUES ($1,$2,$3,'queued','Waiting for source discovery',$4,$5) RETURNING id,status",[randomUUID(),company.id,question,JSON.stringify({...options,mode:'focused'}),now])).rows[0];
    return row;
  });
}
export async function researchJob(db,id) {
  const row=(await db.query('SELECT r.*,c.nse_symbol FROM research_jobs r JOIN companies c ON c.id=r.company_id WHERE r.id=$1',[id])).rows[0];
  if(!row)return null;
  const {lease_token,...safe}=row;
  return {...safe,documents:(await db.query(`WITH reviewed AS (
      SELECT DISTINCT jsonb_array_elements_text(output->'covered_block_ids')::uuid AS id FROM research_batches WHERE job_id=$1
    )
    SELECT rd.*,a.extraction_status,a.extraction_metadata,coalesce((rd.index_metadata->>'totalPages')::int,(j.output->>'totalPages')::int,(a.extraction_metadata->>'totalPages')::int) AS total_pages,
      counts.prepared AS prepared_pages,counts.reviewed AS reviewed_pages
    FROM research_documents rd LEFT JOIN assets a ON a.disclosure_id=rd.disclosure_id AND a.is_current
    LEFT JOIN processing_jobs j ON j.asset_id=a.id AND j.input_hash=a.content_hash AND j.job_type='extract'
    LEFT JOIN LATERAL (
      SELECT count(DISTINCT b.sequence)::int AS prepared,count(DISTINCT CASE WHEN reviewed.id IS NOT NULL THEN b.sequence END)::int AS reviewed FROM content_blocks b
      LEFT JOIN reviewed ON reviewed.id=b.id
      WHERE b.asset_id=a.id AND b.asset_content_hash=a.content_hash AND b.processor_version IN ($2,$3)
    ) counts ON true WHERE rd.research_job_id=$1 ORDER BY rd.kind,rd.title`,[id,PROCESSOR,INDEX_VERSION])).rows,
    sources:(await db.query(`SELECT s.*,d.status AS download_status,d.metadata->>'selection_reason' AS selection_reason
      FROM research_sources s LEFT JOIN research_documents d ON d.source_id=s.id WHERE s.research_job_id=$1 ORDER BY s.kind,s.title DESC`,[id])).rows,
    evidence:(await db.query('SELECT id,source_url,location,evidence_snapshot,retained_image_path IS NOT NULL AS has_image FROM research_evidence WHERE research_job_id=$1',[id])).rows};
}

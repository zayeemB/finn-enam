import { randomUUID } from 'node:crypto';
import { inputHash } from '../sources.js';
import { ownAnalysis } from './jobs.js';
import { announcementAlerts,financialCard } from '../outputs.js';

function factFingerprint(d) {
  return inputHash({category:d.category,headline:d.headline.toLowerCase().replace(/\s+/g,' ').trim(),
    facts:d.key_facts.map(f=>[f.name.toLowerCase(),f.value.toLowerCase()]).sort(),
    observations:d.observations.map(o=>[o.metric,o.value,o.unit,o.period_start,o.period_end,o.scope]).sort(),
    management:d.management_change ? [d.management_change.person,d.management_change.role,d.management_change.action,d.management_change.effective_date] : null});
}
async function saveObservation(tx,companyId,observation,disclosure,evidence,now) {
  const keys=[companyId,observation.metric,observation.period_start,observation.period_end,observation.frequency,observation.scope,observation.unit];
  const previous=(await tx.query(`SELECT * FROM observations WHERE company_id=$1 AND metric=$2 AND period_start=$3
    AND period_end=$4 AND frequency=$5 AND scope=$6 AND unit=$7 AND is_current`,keys)).rows[0];
  if (previous && Number(previous.value)===observation.value) return;
  const revision=Number((await tx.query(`SELECT coalesce(max(revision),0)+1 AS revision FROM observations
    WHERE company_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4 AND frequency=$5 AND scope=$6 AND unit=$7`,keys)).rows[0].revision);
  const newest=!previous?.source_published_at || +new Date(previous.source_published_at)<=+new Date(disclosure.published_at);
  if (previous && newest) await tx.query('UPDATE observations SET is_current=false WHERE id=$1',[previous.id]);
  const source=evidence[0];
  await tx.query(`INSERT INTO observations(id,company_id,metric,period_start,period_end,frequency,scope,unit,value,
    source_url,disclosure_id,asset_id,content_block_id,evidence_snapshot,revision,is_current,collected_at,source_published_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [randomUUID(),...keys,observation.value,source.source_url,disclosure.id,source.asset_id,source.block_id,
    JSON.stringify({citations:evidence}),revision,newest,now,disclosure.published_at]);
}

export async function persistAnalysis(db,job,input,result,now) {
  return db.transaction(async tx=>{
    await tx.query('SELECT id FROM companies WHERE id=$1 FOR UPDATE',[input.disclosure.company_id]);
    if (!await ownAnalysis(tx,job,now)) return null;
    const blockMap=new Map(input.blocks.map(b=>[b.id,b]));
    let alertCount=0;
    const links=[];
    for (const d of result.developments) {
      const citations=d.evidence.map(c=>{
        const block=blockMap.get(c.block_id);
        return {...c,asset_id:block?.asset_id || null,source_url:block?.asset.source_url || input.disclosure.source_url,
          source_title:input.disclosure.title,published_at:input.disclosure.published_at,
          location:block?.location || {metadata:true},
          image_key:c.modality==='visual' ? block.temporary_image_path : null,
          image_storage_backend:c.modality==='visual' ? block.content.image_storage_backend : null};
      });
      const fingerprint=factFingerprint(d);
      let event=d.matched_event_id ? (await tx.query('SELECT * FROM events WHERE id=$1 AND company_id=$2 FOR UPDATE',[d.matched_event_id,input.disclosure.company_id])).rows[0] : null;
      if (event && event.version!==input.priorEvents.find(e=>e.id===event.id)?.version) throw new Error('Company event context changed; retry synthesis');
      if (!event) event=(await tx.query("SELECT * FROM events WHERE company_id=$1 AND category=$2 AND details->>'fact_fingerprint'=$3 LIMIT 1 FOR UPDATE",
        [input.disclosure.company_id,d.category,fingerprint])).rows[0];
      let relationship=event ? d.relationship==='new' ? 'repeated' : d.relationship : 'initial';
      if (event && event.details.fact_fingerprint===fingerprint) relationship='repeated';
      if (event && d.observations.some(o=>(event.details.observations || []).some(p=>p.metric===o.metric && p.scope===o.scope && p.unit===o.unit && p.period_end===o.period_end && p.value!==o.value))) relationship='correction';
      if (event?.details.latest_publication && +new Date(input.disclosure.published_at)<+new Date(event.details.latest_publication)) relationship='supporting';
      const changed=!!event && ['update','correction'].includes(relationship);
      const id=event?.id || randomUUID(), version=event ? event.version+Number(changed) : 1;
      for (const observation of d.observations) await saveObservation(tx,input.disclosure.company_id,observation,input.disclosure,observation.evidence_indexes.map(i=>citations[i]),now);
      const details={why_it_matters:d.why_it_matters,key_facts:d.key_facts,observations:d.observations,
        management_change:d.management_change,limitations:[...input.limitations,...result.limitations,...d.limitations],
        fact_fingerprint:fingerprint,change_reason:d.change_reason,
        latest_publication:input.disclosure.published_at,
        financials:d.category==='results' ? await financialCard(tx,input.disclosure.company_id,d.observations) : null};
      if (!event) {
        event=(await tx.query(`INSERT INTO events(id,company_id,category,title,summary,details,importance,importance_reason,version,first_seen_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [id,input.disclosure.company_id,d.category,d.headline,d.summary,JSON.stringify(details),d.importance,d.importance_reason,version,now])).rows[0];
      } else if (changed) {
        event=(await tx.query(`UPDATE events SET title=$2,summary=$3,details=$4,importance=$5,importance_reason=$6,version=$7,updated_at=$8 WHERE id=$1 RETURNING *`,
        [id,d.headline,d.summary,JSON.stringify(details),d.importance,d.importance_reason,version,now])).rows[0];
      }
      for (const c of citations) await tx.query(`INSERT INTO event_evidence(id,event_id,event_version,disclosure_id,asset_id,content_block_id,
        source_url,location,evidence_snapshot,retained_image_path,relationship) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [randomUUID(),id,version,input.disclosure.id,c.asset_id,c.block_id,c.source_url,JSON.stringify(c.location),JSON.stringify(c),c.image_key,relationship]);
      const presentation={headline:d.headline,summary:d.summary,importance:d.importance,importance_reason:d.importance_reason,
        category:d.category,...details,evidence:citations};
      const key=inputHash([fingerprint,d.evidence]);
      await tx.query(`INSERT INTO analysis_event_links(job_id,development_key,event_id,event_version,relationship,presentation)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(job_id,development_key) DO UPDATE SET
        event_id=excluded.event_id,event_version=excluded.event_version,relationship=excluded.relationship,presentation=excluded.presentation`,
      [job.id,key,id,version,relationship,JSON.stringify(presentation)]);
      // Never create a new delivery merely because another source repeats an existing event.
      if (['initial','update','correction'].includes(relationship)) alertCount+=await announcementAlerts(tx,event,citations,now);
      links.push({event_id:id,version,relationship});
    }
    const storedResult={...result,limitations:[...new Set([...input.limitations,...result.limitations])]};
    await tx.query(`UPDATE processing_jobs SET status='completed',output=$2,completed_at=$3,model=$4,lease_token=NULL,
      lease_expires_at=NULL,next_attempt_at=NULL,failure_count=0,error=NULL,error_kind=NULL WHERE id=$1`,
    [job.id,JSON.stringify({result:storedResult,links,alerts_created:alertCount,
      source:{title:input.disclosure.title,source_url:input.disclosure.source_url,published_at:input.disclosure.published_at,input_hash:job.input_hash},
      coverage:{blocks:input.blocks.length,analysed_all_prepared_pages:true,complete:input.limitations.length===0},
      ...(job.analysis_provenance || {model:job.model,models_used:[job.model]})}),now,job.analysis_provenance?.model || job.model]);
    return {events:links.length,alerts_created:alertCount};
  });
}

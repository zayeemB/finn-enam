import {randomUUID} from 'node:crypto';
import {SourceClient} from '../http.js';
import {hash,inputHash,fetchDisclosures} from '../sources.js';
import {configuredModels} from '../analysis/models.js';
import {pageImage} from '../analysis/input.js';
import {PROCESSOR} from '../extraction/jobs.js';
import {discover,exchangeSources,primaryUrl} from './sources.js';
import {initialSources,additionalSources} from './selection.js';
import {pageGrammar,reportGrammar,RESEARCH_SYSTEM,sourcePassages,validatePage,validateReport,topics} from './schema.js';
import {focusedResearch} from './focused.js';
import {limits as briefLimits} from './brief.js';

async function claim(db,now,budgetMs) {
  return db.transaction(async tx=>{
    const job=(await tx.query(`SELECT r.*,c.nse_symbol FROM research_jobs r JOIN companies c ON c.id=r.company_id
      WHERE (r.status IN ('queued','waiting') AND (r.next_attempt_at IS NULL OR r.next_attempt_at<=$1))
      OR (r.status='running' AND r.lease_expires_at<=$1)
      ORDER BY coalesce(r.last_claimed_at,r.created_at),r.created_at,r.id LIMIT 1 FOR UPDATE OF r SKIP LOCKED`,[now])).rows[0];
    if(!job)return null;
    const token=randomUUID();
    if(job.research_state.provider_wait){
      job.research_state={...job.research_state,brief_started_at:now.toISOString(),calls:0,provider_wait:false};
      await tx.query('UPDATE research_jobs SET research_state=$2 WHERE id=$1',[job.id,JSON.stringify(job.research_state)]);
    }
    if(job.options.mode!=='full'&&!job.research_state.brief_started_at){
      job.research_state={...job.research_state,brief_started_at:now.toISOString()};
      await tx.query('UPDATE research_jobs SET research_state=$2 WHERE id=$1',[job.id,JSON.stringify(job.research_state)]);
    }
    await tx.query("UPDATE research_jobs SET status='running',lease_token=$2,lease_expires_at=$3,started_at=coalesce(started_at,$4),last_claimed_at=$4,next_attempt_at=NULL WHERE id=$1",[job.id,token,new Date(+now+budgetMs+60000),now]);
    return {...job,started_at:job.started_at || now,lease_token:token};
  });
}
async function owned(tx,job,now) {
  return (await tx.query("SELECT id FROM research_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>$3 FOR UPDATE",[job.id,job.lease_token,now])).rows.length>0;
}
async function release(db,job,progress,now) {
  const saved=await db.query("UPDATE research_jobs SET status='waiting',progress=$3,lease_token=NULL,lease_expires_at=NULL,error=NULL,error_kind=NULL,attempts=0,next_attempt_at=NULL WHERE id=$1 AND lease_token=$2 AND lease_expires_at>$4 RETURNING id",[job.id,job.lease_token,progress,now]);
  return saved.rows.length?{status:'waiting',id:job.id,progress}:{status:'lease_lost',id:job.id};
}
async function selectDocument(db,job,source,clock){
  return db.transaction(async tx=>{
    if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
    return (await tx.query(`INSERT INTO research_documents(id,research_job_id,kind,title,source_url,discovery_url,source_id,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(research_job_id,source_url) DO UPDATE SET source_id=excluded.source_id RETURNING *`,
      [randomUUID(),job.id,source.kind,source.title,source.source_url,source.discovery_url,source.id||null,
        JSON.stringify({...source.metadata,selection_reason:source.selection_reason})])).rows[0];
  });
}
async function attachDocument(db,files,job,document,client,clock) {
  const saved=(await db.query(`SELECT a.*,d.id AS disclosure,d.source_url AS primary_url FROM assets a JOIN disclosures d ON d.id=a.disclosure_id
    WHERE d.company_id=$1 AND a.source_url=$2 AND a.download_status='downloaded'
    AND a.is_current ORDER BY a.downloaded_at DESC LIMIT 1`,[job.company_id,document.source_url])).rows[0];
  if(saved && saved.storage_backend===files.backend && await files.exists(saved.temporary_file_path)){
    await db.transaction(async tx=>{
      if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
      const metadata={...document.metadata,primary_url:primaryUrl(saved.primary_url,document.discovery_url,job.options.allowed_hosts||[]),content_hash:saved.content_hash,reused:true};
      await tx.query("UPDATE research_documents SET disclosure_id=$2,status='downloaded',error=NULL,metadata=$3 WHERE id=$1",[document.id,saved.disclosure,JSON.stringify(metadata)]);
    });
    return;
  }
  const response=await client.get(document.source_url);
  const resolved=primaryUrl(response.url||document.source_url,document.discovery_url,job.options.allowed_hosts||[]);
  if(!response.body.subarray(0,1024).toString('latin1').trimStart().startsWith('%PDF-'))throw new Error('Primary document URL did not return a PDF');
  const contentHash=hash(response.body),disclosureId=randomUUID(),assetId=randomUUID(),token=randomUUID();
  const key=await files.put(response.body);
  const now=clock();
  await db.transaction(async tx=>{
    if(!await owned(tx,job,now))throw new Error('Research lease lost');
    const disclosure=(await tx.query(`INSERT INTO disclosures(id,company_id,source,source_key,title,source_url,published_at,first_seen_at,raw_metadata,metadata_hash,updated_at,collection_mode)
      VALUES ($1,$2,'research_primary',$3,$4,$5,$6,$9,$7,$8,$9,'research')
      ON CONFLICT(company_id,source,source_key) DO UPDATE SET title=excluded.title RETURNING id`,
    [disclosureId,job.company_id,inputHash([resolved,contentHash]),document.title,resolved,document.metadata?.published_at||now,
      JSON.stringify({document_kind:document.kind,source_label:document.title,discovered_via:document.discovery_url,...document.metadata}),inputHash([document.kind,document.title]),now])).rows[0];
    const asset=(await tx.query(`INSERT INTO assets(id,disclosure_id,source_url,last_seen_at,lease_token,lease_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(disclosure_id,source_url) DO UPDATE SET lease_token=excluded.lease_token,lease_expires_at=excluded.lease_expires_at RETURNING *`,
    [assetId,disclosure.id,document.source_url,now,token,new Date(+now+300000)])).rows[0];
    await tx.query(`UPDATE assets SET content_hash=$2,byte_size=$3,temporary_file_path=$4,storage_backend=$5,media_type='application/pdf',
      download_status='downloaded',downloaded_at=$6,checked_at=$6,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,[asset.id,contentHash,response.body.length,key,files.backend,now]);
    if(job.options.mode==='full')await tx.query("INSERT INTO processing_jobs(id,job_type,disclosure_id,asset_id,input_hash,created_at) VALUES ($1,'extract',$2,$3,$4,$5) ON CONFLICT DO NOTHING",[randomUUID(),disclosure.id,asset.id,contentHash,now]);
    await tx.query("UPDATE research_documents SET disclosure_id=$2,status='downloaded',error=NULL,metadata=metadata || $3::jsonb WHERE id=$1",
      [document.id,disclosure.id,JSON.stringify({primary_url:resolved,publisher:new URL(resolved).hostname,content_hash:contentHash,downloaded_at:now})]);
  });
}

export async function research(db,files,{budgetMs=45000,batchLimit=4,clock=()=>new Date(),discoverSources=discover,clientFactory=opts=>new SourceClient(opts),fetchExchange=fetchDisclosures,model:injectedModel}={}) {
  if(!Number.isSafeInteger(batchLimit) || batchLimit<1)throw new Error('Invalid research batch limit');
  const job=await claim(db,clock(),budgetMs);if(!job)return {status:'idle'};
  const deadline=job.options.mode==='full'?Date.now()+budgetMs:
    Math.min(Date.now()+budgetMs,+new Date(job.research_state.brief_started_at)+briefLimits.totalMs);
  try {
    const documents=(await db.query('SELECT * FROM research_documents WHERE research_job_id=$1 ORDER BY kind,title,id',[job.id])).rows;
    if(!documents.length) {
      const discovery=await discoverSources(job.nse_symbol,job.options,{deadline});
      if(discovery.catalogue&&job.options.source_policy!=='assignment'){
        const saved=(await db.query("SELECT title,source_url,published_at,raw_metadata FROM disclosures WHERE company_id=$1 AND collection_mode='monitoring' AND published_at>=$2",[job.company_id,new Date(+clock()-90*86400000)])).rows;
        const seen=new Set(discovery.catalogue.map(d=>d.source_url));
        for(const doc of exchangeSources(saved.map(r=>({title:r.title,publishedAt:r.published_at,rawMetadata:r.raw_metadata,assets:[{sourceUrl:r.source_url}]})),'https://www.nseindia.com/companies-listing/corporate-filings-announcements',discovery.allowedHosts))if(!seen.has(doc.source_url)){discovery.catalogue.push(doc);seen.add(doc.source_url);}
      }
      const selected=discovery.catalogue?initialSources(discovery.catalogue,job.options.source_policy):discovery.documents;
      if(!selected?.length)throw new Error('No accessible primary research documents found for this ticker');
      await db.transaction(async tx=>{
        if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
        for(const doc of discovery.catalogue||[])await tx.query(`INSERT INTO research_sources(id,research_job_id,kind,title,source_url,discovery_url,metadata)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,[randomUUID(),job.id,doc.kind,doc.title,doc.source_url,doc.discovery_url,JSON.stringify(doc.metadata||{})]);
        await tx.query('UPDATE research_jobs SET options=options || $2::jsonb WHERE id=$1',[job.id,JSON.stringify({allowed_hosts:discovery.allowedHosts})]);
        await tx.query('UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1',[job.id,JSON.stringify({discovery_warnings:discovery.warnings||[],catalogue_size:discovery.catalogue?.length||0})]);
      });
      const catalogue=(await db.query('SELECT * FROM research_sources WHERE research_job_id=$1',[job.id])).rows;
      for(const doc of selected)await selectDocument(db,job,{...doc,id:catalogue.find(s=>s.source_url===doc.source_url)?.id},clock);
      return release(db,job,`Found ${discovery.catalogue?.length||selected.length} source links; selected current sources for the first brief`,clock());
    }
    const pending=documents.find(d=>d.status==='pending');
    if(pending) {
      try {await attachDocument(db,files,job,pending,clientFactory({deadline,allowedHosts:job.options.allowed_hosts || []}),clock);}
      catch(error){await db.query(`UPDATE research_documents SET status='failed',error=$2 WHERE id=$1 AND EXISTS
        (SELECT 1 FROM research_jobs WHERE id=$3 AND lease_token=$4 AND lease_expires_at>$5)`,[pending.id,error.message,job.id,job.lease_token,clock()]);}
      return release(db,job,'Primary documents downloading/preparing pages',clock());
    }
    if(job.options.mode!=='full'){
      const catalogue=(await db.query('SELECT * FROM research_sources WHERE research_job_id=$1',[job.id])).rows;
      const exchangeTried=new Set();
      const acquireSource=async context=>{
        let next=additionalSources(catalogue,documents,{...context,question:job.question,policy:job.options.source_policy})[0];
        if(!next)return null;
        // Older quarterly links can require login. Look for the actual exchange filing for that period first.
        if(next.metadata?.resolver&&!exchangeTried.has(next.metadata.period_end)&&Date.now()+3000<context.deadline){
          exchangeTried.add(next.metadata.period_end);
          try{
            const start=new Date(next.metadata.period_end+'T00:00:00+05:30'),end=new Date(Math.min(+clock(),+start+75*86400000));
            const rows=await fetchExchange(clientFactory({deadline:Math.min(context.deadline,Date.now()+12000)}),job.nse_symbol,start,end);
            await db.transaction(async tx=>{
              if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
              for(const source of exchangeSources(rows,'https://www.nseindia.com/companies-listing/corporate-filings-announcements',job.options.allowed_hosts||[])){
                const added=(await tx.query(`INSERT INTO research_sources(id,research_job_id,kind,title,source_url,discovery_url,metadata)
                  VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(research_job_id,source_url) DO NOTHING RETURNING *`,
                  [randomUUID(),job.id,source.kind,source.title,source.source_url,source.discovery_url,JSON.stringify(source.metadata)])).rows[0];
                if(added)catalogue.push(added);
              }
            });
            next=additionalSources(catalogue,documents,{...context,question:job.question,policy:job.options.source_policy})[0]||next;
          }catch(error){if(/lease lost/i.test(error.message))throw error;}
        }
        const doc=await selectDocument(db,job,next,clock);documents.push(doc);
        try{await attachDocument(db,files,job,doc,clientFactory({deadline:Math.min(context.deadline,Date.now()+15000),allowedHosts:job.options.allowed_hosts||[]}),clock);}
        catch(error){
          if(/lease lost/i.test(error.message))throw error;
          await db.transaction(async tx=>{
            if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
            await tx.query("UPDATE research_documents SET status='failed',error=$2 WHERE id=$1",[doc.id,error.message]);
          });
        }
        Object.assign(doc,(await db.query('SELECT * FROM research_documents WHERE id=$1',[doc.id])).rows[0]);
        return doc;
      };
      return await focusedResearch(db,files,job,documents,{clock,model:injectedModel,budgetMs,acquireSource:catalogue.length?acquireSource:null});
    }
    const blocks=[],limitations=[],unfinished=new Set();let preparing=false;
    for(const doc of documents) {
      if(doc.status==='failed'){limitations.push(`Unavailable ${doc.kind}: ${doc.error}`);continue;}
      const asset=(await db.query('SELECT * FROM assets WHERE disclosure_id=$1 AND is_current',[doc.disclosure_id])).rows[0];
      const extraction=(await db.query("SELECT failure_count FROM processing_jobs WHERE asset_id=$1 AND job_type='extract'",[asset?.id || null])).rows[0];
      if(asset?.extraction_status==='unsupported' || (asset?.extraction_status==='failed' && extraction?.failure_count>=5)) {
        limitations.push(`Unprocessed ${doc.title}: ${asset.extraction_error}`);continue;
      }
      if(!asset || ['pending','failed'].includes(asset.extraction_status) || (asset.extraction_status==='partial' && asset.extraction_metadata?.yielded!==false)){
        preparing=true;unfinished.add(doc.id);
      }
      if(asset?.extraction_status==='partial' && asset.extraction_metadata?.yielded===false) {
        limitations.push(`Incomplete attachment coverage for ${doc.title}: ${asset.extraction_error || 'embedded content unsupported'}`);
      }
      if(!asset?.content_hash)continue;
      const pages=(await db.query('SELECT id,asset_id,asset_content_hash,sequence,location,temporary_image_path FROM content_blocks WHERE asset_id=$1 AND asset_content_hash=$2 AND processor_version=$3 ORDER BY sequence',[asset.id,asset.content_hash,PROCESSOR])).rows;
      blocks.push(...pages.map(b=>({...b,asset,document:doc})));
      if(asset.extraction_status==='complete' && (pages.length!==asset.extraction_metadata?.totalPages || pages.some((p,i)=>p.sequence!==i+1)))throw new Error('Research source page coverage is incomplete');
    }
    const model=injectedModel || configuredModels(db),cached=(await db.query('SELECT * FROM research_batches WHERE job_id=$1 ORDER BY created_at,cache_key',[job.id])).rows;
    const blockMap=new Map(blocks.map(b=>[b.id,b])),covered=new Set(),mapRows=[];
    // Old checkpoints can straddle documents or overlap as extraction appended pages.
    for(const row of cached){
      const ids=row.output.covered_block_ids;
      if(ids.every(id=>blockMap.has(id)) && ids.some(id=>!covered.has(id))){
        mapRows.push(row);for(const id of ids)covered.add(id);
      }
    }
    const batchSize=Math.min(4,...(model.clients || []).map(c=>c.preferredBatchSize || c.maxImages || 4));
    const recheck=new Set(job.recheck_page_ids || []);
    const groups=[];
    for(const doc of documents){
      const unread=blocks.filter(b=>b.document.id===doc.id && !covered.has(b.id));
      for(let i=0;i<unread.length;){
        // An incomplete multi-page reply is retried one page at a time, including after a restart.
        if(recheck.has(unread[i].id)){groups.push([unread[i++]]);continue;}
        const start=i;
        while(i<unread.length && i-start<batchSize && !recheck.has(unread[i].id))i++;
        if(i-start===batchSize || i<unread.length || !unfinished.has(doc.id))groups.push(unread.slice(start,i));
      }
    }
    let calls=0;
    const remainingMs=()=>Math.min(300000,deadline-Date.now()-1000);
    const onAttempt=()=>{const ms=remainingMs();if(ms<=0)throw Object.assign(new Error('Research time budget reached'),{budget:true});return ms;};
    const setProgress=async progress=>{
      const changed=await db.query("UPDATE research_jobs SET progress=$3 WHERE id=$1 AND lease_token=$2 AND lease_expires_at>$4 RETURNING id",[job.id,job.lease_token,progress,clock()]);
      if(!changed.rows.length)throw new Error('Research lease lost');
    };
    for(const group of groups){
      if(calls>=batchLimit || remainingMs()<=0)return release(db,job,`AI review saved for ${covered.size} pages`,clock());
      const labels=group.map((_,index)=>`p${index+1}`);
      const contents=(await db.query(`SELECT id,content->>'text' AS text,content->>'image_sha256' AS image_sha256,
        content->>'image_storage_backend' AS image_storage_backend FROM content_blocks WHERE id=ANY($1::uuid[])`,[group.map(b=>b.id)])).rows;
      for(const block of group)block.content=contents.find(row=>row.id===block.id);
      const range=group.map(b=>b.location.page).join(', ');
      await setProgress(`AI reading ${group[0].document.title}, page${group.length===1?'':'s'} ${range}`);
      const images=await Promise.all(group.map(async(b,i)=>({...await pageImage(files,b),blockId:labels[i]})));
      const retryPage=group.length===1 && recheck.has(group[0].id);
      const response=await model.generate({stage:'page_extraction',systemInstruction:RESEARCH_SYSTEM,responseSchema:pageGrammar(labels),
        prompt:JSON.stringify({question:job.question,pages:group.map((b,i)=>({block_id:labels[i],source_title:b.document.title,page:b.location.page,
          passages:sourcePassages(b.content.text).map((text,index)=>({id:index+1,text}))})),...(job.error_kind==='validation'?{previous_validation_error:job.error}: {})}),
        images,timeoutMs:onAttempt(),onAttempt});
      calls++;
      let output;
      try{output=validatePage(response.data,group,{allowPartial:retryPage});}
      catch(error){
        error.kind='validation';
        if(!retryPage)error.recheck=group.map(b=>b.id);
        throw error;
      }
      const key=inputHash(['research-page-v2',job.question,group.map(b=>[b.id,b.asset_content_hash])]);
      const row={model:response.model || model.model,output};
      await db.transaction(async tx=>{
        if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
        await tx.query('INSERT INTO research_batches VALUES ($1,$2,$3,$4,$5)',[job.id,key,row.model,JSON.stringify(output),clock()]);
        await tx.query('UPDATE research_jobs SET attempts=0,error=NULL,error_kind=NULL,progress=$2 WHERE id=$1',[job.id,`AI review saved for ${covered.size+group.length} pages`]);
      });
      job.attempts=0;job.error_kind=null;mapRows.push(row);for(const b of group)covered.add(b.id);
    }
    if(preparing)return release(db,job,`Waiting for extraction; ${blocks.length} pages prepared`,clock());
    if(!blocks.length)throw new Error('No primary source pages could be prepared');
    if(covered.size!==blocks.length)throw new Error('Some prepared pages still require AI review');
    const facts=[...new Map(mapRows.flatMap(row=>row.output.findings).map(f=>[inputHash(f),f])).values()];
    const sourceKinds=new Set(blocks.map(b=>b.document.kind));
    for(const kind of ['annual_report','transcript'])if(!sourceKinds.has(kind))limitations.push(`No usable ${kind} available`);
    limitations.push(...mapRows.flatMap(row=>row.output.limitations));
    const input=JSON.stringify({company:job.nse_symbol,question:job.question,topics,validated_findings:facts.map((f,index)=>({index,...f})),limitations});
    if(calls>=batchLimit || remainingMs()<=0)return release(db,job,'All prepared pages reviewed. Waiting to write the report.',clock());
    await setProgress('All prepared pages reviewed. Writing and checking the report.');
    let synthesisModel,report;
    try{
      if(input.length>2000000)throw Object.assign(new Error('The combined evidence exceeds the report writer’s input size.'),{kind:'synthesis_limit'});
      const response=await model.generate({stage:'final_synthesis',systemInstruction:RESEARCH_SYSTEM,responseSchema:reportGrammar,
        prompt:input,timeoutMs:onAttempt(),onAttempt});
      try{report=validateReport(response.data,facts);}
      catch(error){error.kind='synthesis_validation';throw error;}
      synthesisModel=response.model || model.model;
    }catch(error){
      // The research question was already used to select and validate every fact.
      // An unavailable writer must not hide evidence already paid for and saved.
      if(!facts.length || (!error.retryable && !['synthesis_validation','synthesis_limit'].includes(error.kind)))throw error;
      const reason=error.retryable?'The report-writing model was temporarily unavailable.':error.kind==='synthesis_limit'?error.message:'The generated report did not pass citation checks.';
      limitations.push(`${reason} Showing validated page findings grouped by topic.`);
      report={title:`${job.nse_symbol} · Source findings`,sections:topics.flatMap(topic=>{
        const findings=facts.flatMap((f,index)=>f.topic===topic?[{statement:f.fact,evidence_indexes:[index]}]:[]);
        return findings.length?[{topic,status:'available',findings}]:[];
      }),limitations:[]};
    }
    const visualPages=new Set(facts.flatMap(f=>f.evidence.filter(c=>c.modality==='visual').map(c=>c.block_id)));
    for(const id of visualPages)if(!await files.exists(blockMap.get(id).temporary_image_path))throw new Error('Research visual evidence is missing');
    await db.transaction(async tx=>{
      if(!await owned(tx,job,clock()))throw new Error('Research lease lost');
      await tx.query('DELETE FROM research_evidence WHERE research_job_id=$1',[job.id]);
      const evidenceRows=[];
      for(let index=0;index<facts.length;index++)for(const c of facts[index].evidence) {
        const block=blockMap.get(c.block_id),id=randomUUID();
        const snapshot={...c,fact_index:index,fact:facts[index].fact,source_title:block.document.title};
        await tx.query(`INSERT INTO research_evidence(id,research_job_id,disclosure_id,asset_id,content_block_id,source_url,location,evidence_snapshot,retained_image_path)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,job.id,block.document.disclosure_id,block.asset_id,block.id,block.document.source_url,JSON.stringify(block.location),JSON.stringify(snapshot),c.modality==='visual'?block.temporary_image_path:null]);
        evidenceRows.push({id,fact_index:index,source_url:block.document.source_url,page:block.location.page,quote:c.quote,modality:c.modality});
      }
      const missingTopics=topics.filter(topic=>!report.sections.some(s=>s.topic===topic && s.status==='available'));
      const result={...report,limitations:[...new Set([...limitations,...report.limitations])],evidence:evidenceRows,
        report_type:synthesisModel?'synthesis':'source_findings',
        models_used:[...new Set([...mapRows.map(r=>r.model),...(synthesisModel?[synthesisModel]:[])])],missing_topics:missingTopics};
      await tx.query(`UPDATE research_jobs SET status=$3,progress='Report ready',result=$4,data_as_of=$5,completed_at=$6,
        error=NULL,error_kind=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2`,
      [job.id,job.lease_token,limitations.length?'partial':'completed',JSON.stringify(result),JSON.stringify({collected_at:clock(),pages:blocks.length,
        documents:documents.map(d=>({title:d.title,kind:d.kind,url:d.source_url,status:d.status})),all_prepared_pages_read:true}),clock()]);
    });
    return {status:limitations.length?'partial':'completed',id:job.id};
  }catch(error) {
    if(error.budget)return release(db,job,'Continuing on the next research turn',clock());
    if(job.options.mode!=='full'){
      const saved=await db.query(`UPDATE research_jobs SET status='failed',progress='Research could not prepare a brief',error=$3,
        error_kind='processing',next_attempt_at=NULL,lease_token=NULL,lease_expires_at=NULL
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>$4 RETURNING id`,[job.id,job.lease_token,error.message,clock()]);
      return {status:saved.rows.length?'failed':'lease_lost',id:job.id,error:error.message};
    }
    const configuration=error.configuration || [400,401,402,403,404].includes(error.status) || /Set (GEMINI|GROQ)_API_KEY/.test(error.message);
    const quota=!configuration&&(error.quotaLimited||error.status===429);
    const kind=configuration?'configuration':quota?'quota_limit':error.retryable?'provider_transient':error.kind==='validation'?'validation':'processing';
    const attempts=(job.error_kind===kind?job.attempts:0)+1;
    const retry=!configuration && !quota && (kind==='provider_transient' || !!error.recheck || attempts<5);
    const delay=error.recheck?0:Math.max(error.retryAfterMs || 0,Math.min(3600000,60000*2**Math.min(attempts-1,6)));
    const status=retry?'waiting':'failed',progress=quota?'Model request limit reached. Retry when quota is available.':error.recheck?'Retrying the affected pages individually':retry?'Waiting for automatic retry':'Research needs attention';
    const saved=await db.query(`UPDATE research_jobs SET status=$3,progress=$4,error=$5,error_kind=$6,
      attempts=$7,next_attempt_at=$8,recheck_page_ids=coalesce($9::uuid[],recheck_page_ids),lease_token=NULL,lease_expires_at=NULL,
      research_state=research_state || $11::jsonb
      WHERE id=$1 AND lease_token=$2 AND lease_expires_at>$10 RETURNING id`,
    [job.id,job.lease_token,status,progress,error.message,kind,attempts,retry?new Date(+clock()+delay):null,error.recheck || null,clock(),JSON.stringify(quota?{quota_retry_at:new Date(+clock()+(error.quotaRetryAfterMs||delay))}:{})]);
    return {status:saved.rows.length?status:'lease_lost',id:job.id,error:error.message};
  }
}

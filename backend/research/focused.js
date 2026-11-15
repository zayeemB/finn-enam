import {buildExhibits} from './exhibits.js';
import {randomUUID} from 'node:crypto';
import {RenderSession} from '../extraction/renderer.js';
import {hash} from '../sources.js';
import {GeminiClient} from '../analysis/gemini.js';
import {AnalysisModels,geminiClients} from '../analysis/models.js';
import {initialEvidence,expansionEvidence,evidenceGaps,mergeBriefs,passageKey} from './adaptive.js';
import {GroqBrief} from './groq-brief.js';
import {BRIEF_VERSION,INDEX_VERSION,limits,passagesFor,briefGrammar,BRIEF_SYSTEM,validateBrief} from './brief.js';

const sourceContext=doc=>({period:doc.metadata?.period_label,period_end:doc.metadata?.period_end,
  published_at:doc.metadata?.published_at,scope:doc.metadata?.scope||'unknown',publisher:doc.metadata?.publisher,
  revision_notice:doc.metadata?.revision_notice});

function researchModels(db){
  const primary=process.env.RESEARCH_MODEL || 'gemini-3.5-flash-lite';
  const fallback=process.env.RESEARCH_FALLBACK_MODEL || process.env.GEMINI_REASONING_MODEL || 'gemini-3.6-flash';
  const secondary=process.env.RESEARCH_FALLBACK_PROVIDER==='groq'?new GroqBrief():new GeminiClient({model:fallback,transport:'generateContent'});
  return new AnalysisModels(db,{legacyCooldown:false,clients:[...geminiClients({model:primary,transport:'generateContent'}),...(secondary.model===primary?[]:secondary.provider==='gemini'?geminiClients({model:fallback,transport:'generateContent'}):[secondary])]});
}
async function owner(tx,job,now){
  const row=(await tx.query("SELECT * FROM research_jobs WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>$3 FOR UPDATE",[job.id,job.lease_token,now])).rows[0];
  if(!row)throw new Error('Research lease lost');
  return row;
}
async function progress(db,job,text,clock){
  await db.transaction(async tx=>{
    await owner(tx,job,clock());
    await tx.query('UPDATE research_jobs SET progress=$2 WHERE id=$1',[job.id,text]);
  });
}
async function indexedPages(db,files,job,doc,clock,deadline){
  const asset=(await db.query('SELECT * FROM assets WHERE disclosure_id=$1 AND is_current',[doc.disclosure_id])).rows[0];
  if(!asset?.content_hash)throw new Error('Downloaded PDF is unavailable');
  const existing=(await db.query(`SELECT id,sequence,content->>'text' AS text,temporary_image_path,processor_version
    FROM content_blocks WHERE asset_id=$1 AND asset_content_hash=$2 AND processor_version IN ($3,$4) ORDER BY sequence`,
    [asset.id,asset.content_hash,INDEX_VERSION,'pdfjs-pages-v1'])).rows;
  const pageMap=new Map(existing.map(p=>[p.sequence,p]));
  let total=doc.index_metadata?.totalPages || asset.extraction_metadata?.totalPages;
  if(!total||pageMap.size!==total){
    await progress(db,job,'Indexing text from '+doc.title,clock);
    const renderer=new RenderSession();
    try{
      const bytes=await files.get(asset.temporary_file_path);
      if(hash(bytes)!==asset.content_hash)throw new Error('PDF checksum mismatch');
      const remaining=()=>Math.max(1,Math.min(45000,deadline-Date.now()));
      const meta=await renderer.open(bytes,{scale:1.2,maxPixels:3000000},remaining());
      const index=await renderer.index(remaining());
      total=meta.totalPages;
      await db.transaction(async tx=>{
        await owner(tx,job,clock());
        for(const page of index.pages){
          if(pageMap.has(page.page))continue;
          const id=randomUUID(),text=page.text.replaceAll('\0','\uFFFD').toWellFormed();
          const stored=(await tx.query(`INSERT INTO content_blocks(id,asset_id,asset_content_hash,block_type,location,sequence,content,
            extraction_method,status,processor_version) VALUES ($1,$2,$3,'page',$4,$5,$6,'pdfjs_text_index','ready_for_analysis',$7)
            ON CONFLICT(asset_id,asset_content_hash,processor_version,sequence) DO UPDATE SET status=excluded.status RETURNING id`,
            [id,asset.id,asset.content_hash,JSON.stringify({page:page.page}),page.page,JSON.stringify({text,text_error:page.textError}),INDEX_VERSION])).rows[0];
          pageMap.set(page.page,{id:stored.id,sequence:page.page,text,temporary_image_path:null,processor_version:INDEX_VERSION});
        }
      });
    }finally{await renderer.close();}
  }
  await db.transaction(async tx=>{
    await owner(tx,job,clock());
    await tx.query('UPDATE research_documents SET index_metadata=$2 WHERE id=$1',[doc.id,JSON.stringify({totalPages:total,indexedPages:pageMap.size})]);
  });
  return [...pageMap.values()].sort((a,b)=>a.sequence-b.sequence).map(p=>({...p,asset,document:doc,location:{page:p.sequence}}));
}
async function selectedImages(db,files,job,selected,clock,deadline){
  // Financial tables and scans get images. Other pages remain full text.
  const ranked=[...selected].sort((a,b)=>{
    const priority=p=>p.text.trim().length<80?1000:(/cash flows?|balance sheet|financial position/i.test(p.text.slice(0,2000))?100:0)+p.score;
    return priority(b)-priority(a);
  }).slice(0,limits.images);
  const images=[];
  const pending=[];
  for(const p of ranked){
    if(p.temporary_image_path&&await files.exists(p.temporary_image_path)){
      images.push({blockId:p.label+'.visual',bytes:await files.get(p.temporary_image_path),mimeType:'image/png'});
    }else pending.push(p);
  }
  for(const docId of new Set(pending.map(p=>p.document.id))){
    const group=pending.filter(p=>p.document.id===docId),renderer=new RenderSession();
    try{
      await renderer.open(await files.get(group[0].asset.temporary_file_path),{scale:1.2,maxPixels:3000000},Math.max(1,Math.min(15000,deadline-Date.now())));
      for(const p of group){
        const rendered=await renderer.page(p.sequence,Math.max(1,Math.min(15000,deadline-Date.now())));
        const bytes=Buffer.from(rendered.image),key=await files.put(bytes,{contentType:'image/png'});
        await db.transaction(async tx=>{
          await owner(tx,job,clock());
          await tx.query(`UPDATE content_blocks SET temporary_image_path=$2,content=content || $3::jsonb WHERE id=$1`,
            [p.id,key,JSON.stringify({image_sha256:hash(bytes),image_storage_backend:files.backend})]);
        });
        p.temporary_image_path=key;
        images.push({blockId:p.label+'.visual',bytes,mimeType:'image/png'});
      }
    }finally{await renderer.close();}
  }
  return images;
}

export async function focusedResearch(db,files,job,documents,{clock,model:injectedModel,budgetMs,acquireSource}){
  const jobStart=+new Date(job.research_state.brief_started_at || job.started_at || clock());
  const hardEnd=jobStart+limits.totalMs;
  const end=Math.min(hardEnd,Date.now()+budgetMs-1000);
  const sourceIssues=[];
  const pages=[],limitations=[...(job.research_state.discovery_warnings||[])];
  const effectiveDoc=doc=>({...doc,source_url:doc.metadata?.primary_url||doc.source_url});
  for(const doc of documents){
    if(doc.status==='failed'){sourceIssues.push({title:doc.title,kind:doc.kind,status:'unavailable',reason:doc.error||'Download failed'});continue;}
    try{pages.push(...await indexedPages(db,files,job,effectiveDoc(doc),clock,end));}
    catch(error){
      if(/lease lost/i.test(error.message))throw error;
      sourceIssues.push({title:doc.title,kind:doc.kind,status:'unavailable',reason:error.message});
    }
  }
  if(!pages.length)throw new Error('No primary source pages could be indexed');
  let checkpoint=job.research_state.adaptive;
  if(checkpoint&&!checkpoint.selected.every(p=>pages.some(b=>b.id===p.id)))checkpoint=null;
  let selected=(checkpoint?checkpoint.selected.map(p=>({...pages.find(b=>b.id===p.id),...p})):initialEvidence(pages,job.question).map((p,index)=>({...p,label:'p'+(index+1)})));
  let selectedCharacters=selected.reduce((n,p)=>n+(p.excerpts?.join('').length??p.text.length),0);
  const sourceMap=new Map();
  const input=selected.map(p=>{
    const passages=passagesFor(p,p.label);
    for(const passage of passages)sourceMap.set(passage.id,passage);
    return {title:p.document.title,kind:p.document.kind,source_metadata:sourceContext(p.document),page:p.sequence,passages:passages.map(s=>({id:s.id,text:s.text}))};
  });
  const documentCoverage=()=>documents.map(d=>({document_id:d.id,title:d.title,source_url:d.metadata?.primary_url||d.source_url,kind:d.kind,period:d.metadata?.period_label||null,published_at:d.metadata?.published_at||null,
    total_pages:pages.filter(p=>p.document.id===d.id).length,
    selected_pages:selected.filter(p=>p.document.id===d.id).map(p=>p.sequence)}));
  const coverage=documentCoverage();
  await db.transaction(async tx=>{
    await owner(tx,job,clock());
    await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
      [job.id,JSON.stringify({mode:BRIEF_VERSION,coverage,indexed_pages:pages.length,selected_pages:selected.length,
        selection_strategy:'passages',source_characters:selectedCharacters})]);
  });
  const images=!checkpoint&&Date.now()+10000<end?await selectedImages(db,files,job,selected,clock,end):[];
  for(const image of images)sourceMap.set(image.blockId,{page:selected.find(p=>image.blockId===p.label+'.visual'),visual:true});
  limitations.push('Selected passages from '+selected.length+' pages out of '+pages.length+' indexed pages. The model did not review all text on those pages or the remaining document.');
  const sparse=selected.filter(p=>p.text.trim().length<80);
  if(sparse.length)limitations.push('Some pages have little searchable text. Only the listed page images were available for visual review.');
  let quotaFailure;
  let checked=checkpoint?.checked,responseModel=checkpoint?.model,providerError,modelFailure;
  let reviewed=checkpoint?selected.filter(p=>checkpoint.reviewed.includes(p.id)):selected;
  const models=new Set(checkpoint?.models || []);
  let expansionReviewed=checkpoint?.expansionReviewed || false;
  let expansionPasses=checkpoint?.expansionPasses || (expansionReviewed?1:0);
  let expansionAdded=checkpoint?.added || 0,stopReason=checkpoint?.stopReason || 'coverage_sufficient';
  async function saveCheckpoint(){
    await db.transaction(async tx=>{
      await owner(tx,job,clock());
      await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
        [job.id,JSON.stringify({adaptive:{checked,model:responseModel,models:[...models],reviewed:reviewed.map(p=>p.id),
          selected:selected.map(p=>({id:p.id,label:p.label,excerpts:p.excerpts,score:p.score,temporary_image_path:p.temporary_image_path})),
          added:expansionAdded,stopReason,expanded,expansionReviewed,expansionPasses}})]);
    });
  }
  let expanded=checkpoint?.expanded || false;
  const model=injectedModel || researchModels(db);
  // Each actual request consumes a durable attempt, including failed fallback requests.
  const onAttempt=async()=>{
    if(Date.now()+5000>=end)throw new Error('Research processing budget reached');
    await db.transaction(async tx=>{
      const current=await owner(tx,job,clock());
      if((current.research_state.calls||0)>=limits.attempts)throw new Error('Research request limit reached');
      await tx.query(`UPDATE research_jobs SET research_state=jsonb_set(research_state,'{calls}',to_jsonb(coalesce((research_state->>'calls')::int,0)+1)),
        progress='AI is reading selected evidence and writing the brief' WHERE id=$1`,[job.id]);
    });
    return Math.min(limits.requestMs,end-Date.now()-1000);
  };
  // One corrective request is allowed when the first completed reply is unusable.
  for(let attempt=0;attempt<2&&!checked;attempt++){
    try{
      const request={stage:'research_brief',systemInstruction:BRIEF_SYSTEM,responseSchema:briefGrammar,
        prompt:JSON.stringify({company:job.nse_symbol,question:job.question,evidence:input,
          image_source_ids:images.map(i=>i.blockId),...(providerError?{correction:providerError}: {})}),
        images,timeoutMs:Math.min(limits.requestMs,Math.max(1,end-Date.now()-1000)),onAttempt,
        maxOutputTokens:4500,thinkingLevel:'low'};
      if(!model.routed)request.timeoutMs=await onAttempt();
      const response=await model.generate(request);
      await db.transaction(async tx=>{
        await owner(tx,job,clock());
        await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
          [job.id,JSON.stringify({last_response:response.data,last_model:response.model || model.model})]);
      });
      const actualSources=response.sourceIds?new Map(response.sourceIds.map(id=>[id,sourceMap.get(id)])):sourceMap;
      checked=validateBrief(response.data,actualSources);responseModel=response.model || model.model;models.add(responseModel);
      if(response.sourceIds){
        const actualPages=new Set([...actualSources.values()].map(s=>s.page.id));
        reviewed=selected.filter(p=>actualPages.has(p.id));
        limitations.push('The fallback model reviewed a smaller selection of text passages to fit its free-tier allowance.');
      }
    }catch(error){
      providerError=error.message;modelFailure=error;
      await db.transaction(async tx=>{
        await owner(tx,job,clock());
        await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
          [job.id,JSON.stringify({last_error:error.message.slice(0,1000)})]);
      });
      if(error.retryable || /budget|request limit|lease/i.test(error.message))break;
    }
  }
  let reportType='focused_brief';
  while(checked&&!expanded){
    await saveCheckpoint();
    stopReason='checking_evidence_gaps';
    await publish(false);
    const gaps=evidenceGaps(checked,job.question);
    const current=(await db.query('SELECT research_state FROM research_jobs WHERE id=$1',[job.id])).rows[0];
    if(!gaps.length){stopReason='coverage_sufficient';expanded=true;break;}
    if(Date.now()+5000>=end||(current.research_state.calls||0)>=limits.attempts){stopReason='budget_reached';expanded=true;break;}
    const seen=selected.flatMap(p=>passagesFor(p,p.label).map(s=>passageKey(p,s.text)));
    // Download only to resolve gaps; reserve time for a model answer. The budget is time, not document count.
    const sourceEnd=Math.min(end-10000,Date.now()+Math.min(30000,Math.max(0,(end-Date.now())/3)));
    let retrievalDeferred=false;
    while(acquireSource&&Date.now()+12000<sourceEnd){
      const localQuestions=gaps.filter(g=>expansionEvidence(pages,[g],seen).length).map(g=>g.question);
      const doc=await acquireSource({gaps,pages,localQuestions,deadline:sourceEnd-8000});
      if(!doc)break;
      if(doc.status==='failed'){sourceIssues.push({title:doc.title,kind:doc.kind,status:'unavailable',reason:doc.error||'Download failed'});continue;}
      if(Date.now()+8000>=end){sourceIssues.push({title:doc.title,kind:doc.kind,status:'deferred',reason:'Insufficient preparation time remaining'});retrievalDeferred=true;break;}
      await progress(db,job,'Initial brief saved. Preparing additional source: '+doc.title,clock);
      try{pages.push(...await indexedPages(db,files,job,effectiveDoc(doc),clock,Math.min(end-5000,Date.now()+45000)));}
      catch(error){
        if(/lease lost/i.test(error.message))throw error;
        sourceIssues.push({title:doc.title,kind:doc.kind,status:'unavailable',reason:error.message});
      }
      retrievalDeferred=Date.now()+1000>=sourceEnd;
    }
    const extra=expansionEvidence(pages,gaps,seen);
    if(!extra.length){stopReason=retrievalDeferred?'source_budget_reached':'no_new_evidence';expanded=true;break;}
    if(Date.now()+5000>=end){stopReason='budget_reached';expanded=true;break;}
    await progress(db,job,'Initial brief saved. Checking additional evidence for unresolved questions.',clock);
    const nextLabel=Math.max(0,...selected.map(p=>Number(/^followup(\d+)$/.exec(p.label)?.[1])||0));
    const extraSources=new Map(),extraInput=extra.map((p,index)=>{
      p.label='followup'+(nextLabel+index+1);
      const passages=passagesFor(p,p.label);
      for(const item of passages)extraSources.set(item.id,item);
      return {title:p.document.title,kind:p.document.kind,source_metadata:sourceContext(p.document),page:p.sequence,passages:passages.map(s=>({id:s.id,text:s.text}))};
    });
    try{
      const extraImages=await selectedImages(db,files,job,extra,clock,end);
      for(const image of extraImages)extraSources.set(image.blockId,{page:extra.find(p=>image.blockId===p.label+'.visual'),visual:true});
      const request={stage:'research_expansion',systemInstruction:BRIEF_SYSTEM,responseSchema:briefGrammar,
        prompt:JSON.stringify({company:job.nse_symbol,question:job.question,unresolved_questions:gaps,
          prior_findings:checked.facts.map(f=>({topic:f.topic,statement:f.fact})),evidence:extraInput,image_source_ids:extraImages.map(i=>i.blockId)}),
        images:extraImages,timeoutMs:Math.min(limits.requestMs,Math.max(1,end-Date.now()-1000)),onAttempt,maxOutputTokens:4500,thinkingLevel:'low'};
      if(!model.routed)request.timeoutMs=await onAttempt();
      const response=await model.generate(request);
      const actual=response.sourceIds?new Map(response.sourceIds.map(id=>[id,extraSources.get(id)])):extraSources;
      await db.transaction(async tx=>{
        await owner(tx,job,clock());
        await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",[job.id,JSON.stringify({expansion_response:response.data})]);
      });
      const known=new Set(checked.facts.map(f=>f.fact.toLowerCase().replace(/\W/g,'')));
      const additionalData={...response.data,sections:response.data.sections?.map(section=>({...section,
        findings:section.findings.filter(f=>!known.has(f.statement.toLowerCase().replace(/\W/g,'')))}))};
      const additional=validateBrief(additionalData,actual);
      expansionReviewed=true;expansionPasses++;
      checked=mergeBriefs(checked,additional);expansionAdded+=checked.added;
      models.add(response.model || model.model);
      for(const [id,source] of extraSources)sourceMap.set(id,source);
      const actualPages=new Set([...actual.values()].map(s=>s.page.id));
      reviewed=[...new Map([...reviewed,...extra.filter(p=>actualPages.has(p.id))].map(p=>[p.id,p])).values()];
      const selections=new Map(selected.map(p=>[p.id,p]));
      for(const page of extra){
        const previous=selections.get(page.id);
        selections.set(page.id,{...page,temporary_image_path:page.temporary_image_path||previous?.temporary_image_path,
          excerpts:[...new Set([...(previous?passagesFor(previous,previous.label).map(p=>p.text):[]),...page.excerpts])]});
      }
      selected=[...selections.values()];
      selectedCharacters=[...sourceMap.values()].filter(s=>!s.visual).reduce((n,s)=>n+s.text.length,0);
      stopReason=checked.added?'targeted_pass_complete':'no_new_findings';
      expanded=!checked.added||!additional.gaps?.length;
    }catch(error){
      if(/lease lost/i.test(error.message))throw error;
      stopReason=/no findings with valid evidence/.test(error.message)?'no_new_findings':'expansion_unavailable';
      providerError=error.message;
      if(error.quotaLimited||error.status===429)quotaFailure=error;
      expanded=!quotaFailure;
      await saveCheckpoint();
      break;
    }
    await saveCheckpoint();
  }
  if(checked)await saveCheckpoint();
  if(!checked&&modelFailure?.retryable){
    const failures=(job.attempts || 0)+1;
    const wait=Math.max(modelFailure.retryAfterMs || 60000,Math.min(3600000,60000*2**Math.min(failures-1,6)));
    await db.transaction(async tx=>{
      await owner(tx,job,clock());
      const quota=modelFailure.quotaLimited||modelFailure.status===429;
      const retryAt=new Date(+clock()+(modelFailure.quotaRetryAfterMs || wait));
      await tx.query(`UPDATE research_jobs SET status=$6,progress='Sources prepared. Waiting for model availability.',
        error=$3,error_kind=$7,attempts=$4,next_attempt_at=CASE WHEN $8 THEN NULL ELSE $5::timestamptz END,
        research_state=research_state || jsonb_build_object('provider_wait',true,'quota_retry_at',$5::timestamptz),
        lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2`,
        [job.id,job.lease_token,providerError,failures,retryAt,quota?'failed':'waiting',quota?'quota_limit':'provider_transient',quota]);
    });
    return {status:modelFailure.quotaLimited||modelFailure.status===429?'failed':'waiting',id:job.id,error:providerError};
  }
  if(!checked){
    // A provider outage still leaves a readable, explicitly extractive evidence view.
    reportType='source_excerpts';
    stopReason='model_unavailable';
    limitations.push('The model could not complete a validated brief within the request budget. Showing selected source excerpts.');
    checked={title:job.nse_symbol+' · Selected source evidence',sections:[{topic:'financial_snapshot',status:'available',findings:[]}],facts:[],limitations:[],dropped:[]};
    const excerpts=selected.map(p=>[...sourceMap.values()].find(s=>!s.visual&&s.page.id===p.id&&s.text.trim().length>80)).filter(Boolean).slice(0,6);
    for(const source of excerpts){
      const index=checked.facts.length;
      checked.facts.push({topic:'financial_snapshot',fact:source.text.trim(),evidence:[{block_id:source.page.id,modality:'text',quote:source.text}]});
      checked.sections[0].findings.push({statement:source.text.trim(),evidence_indexes:[index]});
    }
    if(!checked.facts.length)throw new Error('No readable text evidence and the visual model was unavailable. '+providerError);
  }
  if(checked.dropped.length)limitations.push(checked.dropped.length+' generated findings were excluded because their citations or numerical support failed validation.');
  async function publish(finalizing){
    const coverage=documentCoverage();
    const blockMap=new Map([...pages,...selected].map(p=>[p.id,p])),evidence=[];
    let status;
    await db.transaction(async tx=>{
      await owner(tx,job,clock());
      await tx.query('DELETE FROM research_evidence WHERE research_job_id=$1',[job.id]);
      for(const [index,fact] of checked.facts.entries())for(const citation of fact.evidence){
        const p=blockMap.get(citation.block_id),id=randomUUID();
        const snapshot={...citation,fact_index:index,fact:fact.fact,source_title:p.document.title,source_kind:p.document.kind,source_metadata:p.document.metadata};
        await tx.query(`INSERT INTO research_evidence(id,research_job_id,disclosure_id,asset_id,content_block_id,source_url,location,evidence_snapshot,retained_image_path)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [id,job.id,p.document.disclosure_id,p.asset.id,p.id,p.document.source_url,JSON.stringify(p.location),JSON.stringify(snapshot),citation.modality==='visual'?p.temporary_image_path:null]);
        evidence.push({id,fact_index:index,source_url:p.document.source_url,page:p.sequence,quote:citation.quote,modality:citation.modality});
      }
      const result={exhibits:buildExhibits(checked.observations,checked.commitments),observation_exclusions:checked.observation_exclusions||[],title:checked.title,sections:checked.sections,limitations:[...new Set([
          'Selected passages from '+selected.length+' pages out of '+pages.length+' indexed pages. Full-document AI coverage is incomplete.',
          ...limitations.filter(l=>!/^Selected passages from/.test(l)),
          ...checked.limitations.filter(l=>!/^Selected passages from/.test(l)),
          ...(!documents.some(d=>d.kind==='annual_report'&&d.status!=='failed')?['No usable annual report was available.']:[]),
          ...(!documents.some(d=>d.kind==='transcript'&&d.status!=='failed')?['No usable earnings-call transcript was available.']:[])])],
        evidence,report_type:reportType,models_used:responseModel?[...models]:[],
        missing_topics:[],
        coverage:{indexed_pages:pages.length,selected_pages:selected.length,reviewed_pages:responseModel?reviewed.length:0,
          visual_pages:new Set(checked.facts.flatMap(f=>f.evidence.filter(e=>e.modality==='visual').map(e=>e.block_id))).size,source_characters:selectedCharacters,selection_strategy:'adaptive_passages',documents:documents.map(d=>({...coverage.find(c=>c.document_id===d.id),
          selected_pages:reviewed.filter(p=>p.document.id===d.id).map(p=>p.sequence)}))},
        source_policy:job.options.source_policy||'assignment',
        source_selection:{catalogue_size:Number((await tx.query('SELECT count(*) AS n FROM research_sources WHERE research_job_id=$1',[job.id])).rows[0].n),selected_documents:documents.length,downloaded_documents:documents.filter(d=>d.status==='downloaded').length},
        source_issues:sourceIssues,
        elapsed_seconds:Math.round((+clock()-jobStart)/1000),wall_elapsed_seconds:Math.round((+clock()-+new Date(job.created_at))/1000)};
      result.adaptive={passes:responseModel?1+expansionPasses:0,added_findings:expansionAdded,
        stop_reason:stopReason,unresolved_questions:checked?evidenceGaps(checked,job.question):[]};
      if(providerError)result.processing_note=providerError.slice(0,800);
      if(checked.dropped.length)result.validation_exclusions=checked.dropped;
      // Persist the exact pages submitted. This checkpoint also drives progress after completion.
      if(responseModel)await tx.query('INSERT INTO research_batches VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [job.id,BRIEF_VERSION+(finalizing?'-final':'-initial'),responseModel,JSON.stringify({covered_block_ids:reviewed.map(p=>p.id),findings:checked.facts,limitations:checked.limitations}),clock()]);
      await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",[job.id,JSON.stringify({coverage,indexed_pages:pages.length,selected_pages:selected.length,source_characters:selectedCharacters})]);
      status=reportType==='source_excerpts'||checked.dropped.length||coverage.some(d=>['annual_report','transcript'].includes(d.kind)&&!d.total_pages)?'partial':'completed';
      if(quotaFailure){
        status='failed';
        await tx.query("UPDATE research_jobs SET error_kind='quota_limit',research_state=research_state || $2::jsonb WHERE id=$1",
          [job.id,JSON.stringify({quota_retry_at:new Date(+clock()+(quotaFailure.quotaRetryAfterMs||quotaFailure.retryAfterMs||60000))})]);
      }
      if(!finalizing)status='running';
      await tx.query(`UPDATE research_jobs SET status=$3,progress=CASE WHEN $7 THEN 'Brief ready' ELSE 'Initial brief saved. Looking for useful additional evidence.' END,
        result=$4,data_as_of=$5,completed_at=CASE WHEN $7 THEN $6::timestamptz ELSE NULL END,
        error=CASE WHEN error_kind='quota_limit' THEN $8 ELSE NULL END,error_kind=CASE WHEN error_kind='quota_limit' THEN error_kind ELSE NULL END,lease_token=CASE WHEN $7 THEN NULL ELSE lease_token END,
        lease_expires_at=CASE WHEN $7 THEN NULL ELSE lease_expires_at END WHERE id=$1 AND lease_token=$2`,
        [job.id,job.lease_token,status,JSON.stringify(result),JSON.stringify({collected_at:clock(),pages:responseModel?reviewed.length:0,all_prepared_pages_read:!!responseModel&&reviewed.length===pages.length,documents:coverage}),clock(),finalizing,providerError || null]);
    });
    return {status,id:job.id,report_type:reportType};
  }
  return publish(true);
}

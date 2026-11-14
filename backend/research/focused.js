import {randomUUID} from 'node:crypto';
import {RenderSession} from '../extraction/renderer.js';
import {hash} from '../sources.js';
import {GeminiClient} from '../analysis/gemini.js';
import {AnalysisModels} from '../analysis/models.js';
import {GroqBrief} from './groq-brief.js';
import {BRIEF_VERSION,INDEX_VERSION,limits,selectPages,passagesFor,briefGrammar,BRIEF_SYSTEM,validateBrief} from './brief.js';

function researchModels(db){
  const primary=process.env.RESEARCH_MODEL || 'gemini-3.5-flash-lite';
  const fallback=process.env.RESEARCH_FALLBACK_MODEL || process.env.GEMINI_REASONING_MODEL || 'gemini-3.6-flash';
  const secondary=process.env.RESEARCH_FALLBACK_PROVIDER==='groq'?new GroqBrief():new GeminiClient({model:fallback,transport:'generateContent'});
  return new AnalysisModels(db,{legacyCooldown:false,clients:[new GeminiClient({model:primary,transport:'generateContent'}),...(secondary.model===primary?[]:[secondary])]});
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

export async function focusedResearch(db,files,job,documents,{clock,model:injectedModel,budgetMs}){
  const jobStart=+new Date(job.research_state.brief_started_at || job.started_at || clock());
  const hardEnd=jobStart+limits.totalMs;
  const end=Math.min(hardEnd,Date.now()+budgetMs-1000);
  const pages=[],limitations=[];
  for(const doc of documents){
    if(doc.status==='failed'){limitations.push(doc.title+' could not be downloaded.');continue;}
    try{pages.push(...await indexedPages(db,files,job,doc,clock,end));}
    catch(error){
      if(/lease lost/i.test(error.message))throw error;
      limitations.push(doc.title+' could not be indexed: '+error.message);
    }
  }
  if(!pages.length)throw new Error('No primary source pages could be indexed');
  const selected=selectPages(pages,job.question).map((p,index)=>({...p,label:'p'+(index+1)}));
  const selectedCharacters=selected.reduce((n,p)=>n+(p.excerpts?.join('').length??p.text.length),0);
  const sourceMap=new Map();
  const input=selected.map(p=>{
    const passages=passagesFor(p,p.label);
    for(const passage of passages)sourceMap.set(passage.id,passage);
    return {title:p.document.title,page:p.sequence,passages:passages.map(s=>({id:s.id,text:s.text}))};
  });
  const coverage=documents.map(d=>({document_id:d.id,title:d.title,source_url:d.source_url,
    total_pages:pages.filter(p=>p.document.id===d.id).length,
    selected_pages:selected.filter(p=>p.document.id===d.id).map(p=>p.sequence)}));
  await db.transaction(async tx=>{
    await owner(tx,job,clock());
    await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
      [job.id,JSON.stringify({mode:BRIEF_VERSION,coverage,indexed_pages:pages.length,selected_pages:selected.length,
        selection_strategy:'passages',source_characters:selectedCharacters})]);
  });
  const images=Date.now()+10000<end?await selectedImages(db,files,job,selected,clock,end):[];
  for(const image of images)sourceMap.set(image.blockId,{page:selected.find(p=>image.blockId===p.label+'.visual'),visual:true});
  limitations.push('Selected passages from '+selected.length+' pages out of '+pages.length+' indexed pages. The model did not review all text on those pages or the remaining document.');
  const sparse=selected.filter(p=>p.text.trim().length<80);
  if(sparse.length)limitations.push('Some pages have little searchable text. Only the listed page images were available for visual review.');
  let checked,responseModel,providerError,reviewed=selected;
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
      checked=validateBrief(response.data,actualSources);responseModel=response.model || model.model;
      if(response.sourceIds){
        const actualPages=new Set([...actualSources.values()].map(s=>s.page.id));
        reviewed=selected.filter(p=>actualPages.has(p.id));
        limitations.push('The fallback model reviewed a smaller selection of text passages to fit its free-tier allowance.');
      }
    }catch(error){
      providerError=error.message;
      await db.transaction(async tx=>{
        await owner(tx,job,clock());
        await tx.query("UPDATE research_jobs SET research_state=research_state || $2::jsonb WHERE id=$1",
          [job.id,JSON.stringify({last_error:error.message.slice(0,1000)})]);
      });
      if(error.retryable || /budget|request limit|lease/i.test(error.message))break;
    }
  }
  let reportType='focused_brief';
  if(!checked){
    // A provider outage still leaves a readable, explicitly extractive evidence view.
    reportType='source_excerpts';
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
  const blockMap=new Map(selected.map(p=>[p.id,p])),evidence=[];
  let status;
  await db.transaction(async tx=>{
    await owner(tx,job,clock());
    await tx.query('DELETE FROM research_evidence WHERE research_job_id=$1',[job.id]);
    for(const [index,fact] of checked.facts.entries())for(const citation of fact.evidence){
      const p=blockMap.get(citation.block_id),id=randomUUID();
      const snapshot={...citation,fact_index:index,fact:fact.fact,source_title:p.document.title};
      await tx.query(`INSERT INTO research_evidence(id,research_job_id,disclosure_id,asset_id,content_block_id,source_url,location,evidence_snapshot,retained_image_path)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id,job.id,p.document.disclosure_id,p.asset.id,p.id,p.document.source_url,JSON.stringify(p.location),JSON.stringify(snapshot),citation.modality==='visual'?p.temporary_image_path:null]);
      evidence.push({id,fact_index:index,source_url:p.document.source_url,page:p.sequence,quote:citation.quote,modality:citation.modality});
    }
    const result={title:checked.title,sections:checked.sections,limitations:[...new Set([...limitations,...checked.limitations])],
      evidence,report_type:reportType,models_used:responseModel?[responseModel]:[],
      missing_topics:[],
      coverage:{indexed_pages:pages.length,selected_pages:selected.length,reviewed_pages:responseModel?reviewed.length:0,
        visual_pages:responseModel&&reviewed===selected?images.length:0,source_characters:selectedCharacters,selection_strategy:'passages',documents:coverage},
      elapsed_seconds:Math.round((+clock()-jobStart)/1000)};
    if(providerError)result.processing_note=providerError.slice(0,800);
    if(checked.dropped.length)result.validation_exclusions=checked.dropped;
    // Persist the exact pages submitted. This checkpoint also drives progress after completion.
    if(responseModel)await tx.query('INSERT INTO research_batches VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [job.id,BRIEF_VERSION,responseModel,JSON.stringify({covered_block_ids:reviewed.map(p=>p.id),findings:checked.facts,limitations:checked.limitations}),clock()]);
    status=reportType==='source_excerpts'||checked.dropped.length||coverage.some(d=>!d.total_pages)?'partial':'completed';
    await tx.query(`UPDATE research_jobs SET status=$3,progress='Brief ready',result=$4,data_as_of=$5,completed_at=$6,
      error=NULL,error_kind=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND lease_token=$2`,
      [job.id,job.lease_token,status,JSON.stringify(result),JSON.stringify({collected_at:clock(),pages:responseModel?reviewed.length:0,all_prepared_pages_read:!!responseModel&&reviewed.length===pages.length,documents:coverage}),clock()]);
  });
  return {status,id:job.id,report_type:reportType};
}

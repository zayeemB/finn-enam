import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCanvas} from '@napi-rs/canvas';
import {openDatabase} from '../db.js';
import {localFiles} from '../files.js';
import {collect} from '../collector.js';
import {setPortfolio,queueAnalysis,jobInputIsCurrent} from '../repository.js';
import {analyse} from '../analysis/worker.js';
import {GeminiClient,ModelError} from '../analysis/gemini.js';
import {GeminiModels,GeminiStages} from '../analysis/models.js';
import {GroqClient} from '../analysis/groq.js';
import {RESPONSE_SCHEMA,resultSchema} from '../analysis/schema.js';
import {claimAnalysis,saveBatch} from '../analysis/jobs.js';
import {analysisOptions} from '../cli.js';
import {digest,alerts,evaluateMarketAlerts,configureRule} from '../outputs.js';
import {hash} from '../sources.js';
import analyseHandler from '../../api/analyse.js';
import digestHandler from '../../api/digest.js';
import alertsHandler from '../../api/alerts.js';

const NOW=new Date('2026-11-12T09:00:00Z');
let db,folder,files;
before(async()=>{db=await openDatabase({memory:true,connectionString:''});});
after(async()=>db.close());
beforeEach(async()=>{
  await db.query('TRUNCATE companies,portfolios,provider_backoff CASCADE');
  folder=await mkdtemp(join(tmpdir(),'finn-analysis-test-'));files=localFiles(folder);
  await setPortfolio(db,['TEST']);
});
afterEach(async()=>rm(folder,{recursive:true,force:true}));

async function seed({key='one',value=1200,period='2026-09-30',publishedAt=NOW,pages=0,extraText=''}={}) {
  const text=`Revenue ${value} INR crore for quarter ended ${period}.${extraText}`;
  const row={source:'nse',sourceKey:key,title:'Quarterly results',sourceUrl:`https://nsearchives.nseindia.com/${key}.pdf`,
    publishedAt:publishedAt.toISOString(),rawMetadata:{text,value,period},
    assets:pages?[{sourceUrl:`https://nsearchives.nseindia.com/${key}.pdf`}]:[]};
  const original=Buffer.from('%PDF-source-fixture');
  await collect(db,files,{now:publishedAt,prices:false,disclosureFeed:async()=>[row],
    client:{get:async()=>({status:200,body:original,headers:new Headers({'content-type':'application/pdf'})})}});
  const disclosure=(await db.query('SELECT * FROM disclosures WHERE source_key=$1',[key])).rows[0];
  if(pages) {
    const asset=(await db.query('SELECT * FROM assets WHERE disclosure_id=$1',[disclosure.id])).rows[0];
    const canvas=createCanvas(300,300);canvas.getContext('2d').fillRect(10,10,200,50);
    const image=canvas.toBuffer('image/png'),imageKey=await files.put(image);
    for(let page=1;page<=pages;page++) await db.query(`INSERT INTO content_blocks
      (id,asset_id,asset_content_hash,block_type,location,sequence,content,temporary_image_path,extraction_method,status,processor_version)
      VALUES ($1,$2,$3,'page',$4,$5,$6,$7,'test','ready_for_analysis','test-v1')`,
    [randomUUID(),asset.id,hash(original),JSON.stringify({page}),page,JSON.stringify({text:page===1?text:'',text_status:page===1?'available':'none',
      image_storage_backend:files.backend,image_sha256:hash(image)}),imageKey]);
    await db.query("UPDATE processing_jobs SET status='completed' WHERE job_type='extract' AND asset_id=$1",[asset.id]);
    await db.query("UPDATE assets SET extraction_status='complete',extraction_processor_version='test-v1',extraction_metadata=$2 WHERE id=$1",[asset.id,JSON.stringify({totalPages:pages})]);
    await db.transaction(tx=>queueAnalysis(tx,disclosure.id,publishedAt));
  }
  return disclosure;
}

function development(source,overrides={}) {
  const period=source.metadata.period,value=source.metadata.value;
  const end=new Date(period),start=new Date(Date.UTC(end.getUTCFullYear(),end.getUTCMonth()-2,1)).toISOString().slice(0,10);
  const block=source.pages.find(p=>p.text);
  return {category:'results',headline:`Quarterly results ${period}`,summary:`Revenue was ${value} INR crore.`,
    why_it_matters:'Shows the reported sales trajectory.',importance:'high',importance_reason:'Quarterly financial results',
    key_facts:[{name:'Revenue',value:String(value),evidence_indexes:[0]}],
    observations:[{metric:'revenue',value,unit:'INR crore',period_start:start,period_end:period,frequency:'quarterly',scope:'consolidated',evidence_indexes:[0]}],
    management_change:null,evidence:[{block_id:block?.block_id || null,modality:block?'text':'metadata',quote:source.metadata.text}],
    relationship:'new',matched_event_id:null,change_reason:null,limitations:[],...overrides};
}
function mockModel({relationship='repeated',transform,afterGenerate}={}) {
  const calls=[];
  return {model:'gemini-3.8-flash',calls,async generate(request){
    calls.push(request);
    const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1));
    let data;
    if(request.stage==='page_extraction') data={covered_block_ids:source.pages.map(p=>p.block_id),developments:[development(source)],limitations:[]};
    else {
      const findings=request.stage==='final_synthesis'?source.findings:source;
      const developments=findings.flatMap(f=>f.developments);
      const previous=(source.previous_events || []).find(e=>e.observations?.some(o=>o.period_end===developments[0]?.observations[0]?.period_end));
      if(previous) for(const d of developments) {d.relationship=relationship;d.matched_event_id=previous.id;d.change_reason=relationship==='repeated'?null:'Updated reported financial figure';}
      data={covered_block_ids:[...new Set(findings.flatMap(f=>f.covered_block_ids))],developments,limitations:[]};
    }
    if(transform) data=await transform(data,request);
    if(afterGenerate) await afterGenerate(data,request);
    return {data,usage:{input_tokens:10,output_tokens:10}};
  }};
}
const run=(model,options={})=>analyse(db,files,{model,clock:()=>NOW,...options});

test('local run completes one disclosure beyond bounded call/time limits and leaves the next queued',async()=>{
  await seed({pages:5});await seed({key:'next',publishedAt:new Date(+NOW+1000)});
  const model=mockModel();
  const report=await run(model,{untilDisclosureComplete:true,callLimit:1,budgetMs:1,pagesPerBatch:2});
  assert.equal(report.jobs.length,1);assert.equal(report.jobs[0].status,'completed');
  assert.equal(report.calls,4);assert.equal(report.remainingJobs,1);
  assert.equal((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse' AND status='queued'")).rows[0].n,1);
});

test('long local calls renew ownership before each attempt and keep their five-minute allowance',async()=>{
  await seed();let now=new Date(NOW);
  const model=mockModel({afterGenerate:async()=>{
    const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
    assert.ok(+new Date(job.lease_expires_at)>=+now+360000);
    now=new Date(+now+305000); // Model wait plus local validation/storage overhead.
  }});
  const report=await run(model,{untilDisclosureComplete:true,requestTimeoutMs:300000,clock:()=>now});
  assert.equal(report.jobs[0].status,'completed');
  assert.ok(model.calls.every(c=>c.timeoutMs===300000));
});

test('local completion mode exits on failure or empty queue instead of retrying forever',async()=>{
  assert.equal((await run(mockModel(),{untilDisclosureComplete:true})).jobs.length,0);
  await seed();let calls=0;
  const model=mockModel();model.generate=async()=>{calls++;throw new ModelError('Temporarily unavailable',{status:503});};
  const report=await run(model,{untilDisclosureComplete:true});
  assert.equal(calls,1);assert.equal(report.status,'provider_unavailable');assert.equal(report.jobs[0].status,'failed');
});

test('local and hosted options both bound request duration and processing',()=>{
  const local=analysisOptions({});const hosted=analysisOptions({},{hosted:true});
  assert.equal(local.untilDisclosureComplete,false);assert.equal(local.requestTimeoutMs,30000);
  assert.equal(hosted.untilDisclosureComplete,false);assert.equal(hosted.requestTimeoutMs,30000);assert.equal(hosted.budgetMs,45000);
});

function routed(primary,fallback,clock=()=>NOW) {
  fallback.model='gemini-3.5-flash-lite';
  return new GeminiModels(db,{clients:[primary,fallback],clock});
}

function stagePair(extraction=mockModel(),reasoning=mockModel()) {
  extraction.model='gemini-3.1-flash-lite';reasoning.model='gemini-3.6-flash';
  const generate=reasoning.generate.bind(reasoning),stages=[];
  reasoning.generate=async request=>{stages.push(request.stage);return generate({...request,
    stage:request.stage==='page_verification'?'page_extraction':request.stage});};
  const router=client=>new GeminiModels(db,{clients:[client],clock:()=>NOW,legacyCooldown:false});
  return {model:new GeminiStages(db,{extraction:router(extraction),reasoning:router(reasoning)}),extraction,reasoning,stages};
}

test('separate Gemini stages read every page with Lite and reason with Flash',async()=>{
  await seed({pages:2});
  const pair=stagePair(mockModel({transform(data){data.developments.forEach(d=>{d.importance='routine';});return data;}}),
    mockModel({transform(data){data.developments.forEach(d=>{d.importance='high';});return data;}}));
  const report=await run(pair.model);
  assert.equal(report.jobs[0].status,'completed');assert.equal(pair.extraction.calls.length,1);
  assert.equal(pair.extraction.calls[0].images.length,2);assert.deepEqual(pair.stages,['final_synthesis']);
  assert.equal((await alerts(db)).length,1);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.equal(job.output.model,'gemini-3.6-flash');
  assert.deepEqual(job.output.models_used,['gemini-3.1-flash-lite','gemini-3.6-flash']);
  assert.deepEqual(job.output.batches.map(b=>[b.stage,b.model]),[['page_extraction','gemini-3.1-flash-lite'],['final_synthesis','gemini-3.6-flash']]);
});

test('changing stage models preserves validated pages produced before the change',async()=>{
  await seed();const old=mockModel();
  assert.equal((await run(old,{callLimit:1})).jobs[0].status,'yielded');
  const pair=stagePair();
  assert.equal((await run(pair.model)).jobs[0].status,'completed');
  assert.equal(pair.extraction.calls.length,0);assert.deepEqual(pair.stages,['final_synthesis']);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.deepEqual(job.output.models_used,['gemini-3.8-flash','gemini-3.6-flash']);
});

test('obsolete Gemini 3.8 and legacy cooldowns do not block the new model pair',async()=>{
  await seed();
  for(const provider of ['gemini','gemini:gemini-3.8-flash']) await db.query("INSERT INTO provider_backoff VALUES ($1,$2,'Provider temporarily unavailable')",[provider,new Date(+NOW+60000)]);
  assert.equal((await run(stagePair().model)).jobs[0].status,'completed');
});

test('reasoning failure retains Lite batches and resumes without reading pages again',async()=>{
  await seed();const pair=stagePair();
  const generate=pair.reasoning.generate;
  pair.reasoning.generate=async()=>{throw new ModelError('Overloaded',{status:503});};
  assert.equal((await run(pair.model)).status,'provider_unavailable');assert.equal(pair.extraction.calls.length,1);
  await db.query('DELETE FROM provider_backoff');
  await db.query("UPDATE processing_jobs SET next_attempt_at=NULL WHERE job_type='analyse'");
  pair.reasoning.generate=generate;
  assert.equal((await run(pair.model)).jobs[0].status,'completed');
  assert.equal(pair.extraction.calls.length,1);
});

test('invalid Lite citations are reread from original pages by the reasoning model',async()=>{
  await seed({pages:1});
  const pair=stagePair(mockModel({transform(data){data.developments[0].evidence[0].quote='Invented Lite quotation';return data;}}));
  const report=await run(pair.model,{callLimit:3});
  assert.equal(report.jobs[0].status,'completed');assert.equal(report.calls,3);
  assert.deepEqual(pair.stages,['page_verification','final_synthesis']);
  assert.equal(pair.reasoning.calls[0].images.length,1);
  const rows=(await db.query('SELECT model,output FROM analysis_batches')).rows;
  assert.ok(rows.every(row=>row.model==='gemini-3.6-flash'));
  assert.ok(!JSON.stringify(rows).includes('Invented Lite quotation'));
});

test('verification with invalid citations cannot publish findings',async()=>{
  await seed();
  const bad=()=>mockModel({transform(data){data.developments[0].evidence[0].quote='Invented quotation';return data;}});
  const pair=stagePair(bad(),bad());
  assert.equal((await run(pair.model,{callLimit:3})).jobs[0].status,'failed');
  assert.equal((await db.query('SELECT * FROM analysis_batches')).rows.length,0);
  assert.equal((await db.query('SELECT * FROM events')).rows.length,0);
});

test('provider grammar omits complex bounds while local validation retains strict limits',()=>{
  const grammar=JSON.stringify(RESPONSE_SCHEMA);
  for (const key of ['maximum','minimum','maxItems','minItems','pattern','maxLength']) assert.ok(!grammar.includes(`"${key}"`));
  assert.ok(grammar.includes('management_change'));assert.ok(grammar.includes('additionalProperties'));
  assert.equal(resultSchema.safeParse({covered_block_ids:[],developments:[],limitations:Array(101).fill('x')}).success,false);
  assert.equal(resultSchema.safeParse({covered_block_ids:['not-a-uuid'],developments:[],limitations:[]}).success,false);
});

test('fallback preserves completed primary batches and records actual models across invocations',async()=>{
  await seed({pages:3});
  const primary=mockModel(),fallback=mockModel();
  const generate=primary.generate.bind(primary);let attempts=0;
  primary.generate=async request=>{attempts++;if(attempts>1) throw new ModelError('High demand',{status:503});return generate(request);};
  const pool=routed(primary,fallback);
  const first=await run(pool,{callLimit:2,pagesPerBatch:2});
  assert.equal(first.calls,2);assert.equal(first.jobs[0].status,'yielded');
  assert.equal(fallback.calls.length,0);
  const second=await run(routed(primary,fallback),{callLimit:2,pagesPerBatch:2});
  assert.equal(second.jobs[0].status,'completed');assert.equal(attempts,2);
  assert.deepEqual(fallback.calls.map(c=>c.stage),['page_extraction','final_synthesis']);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.equal(job.model,fallback.model);assert.equal(job.output.model,fallback.model);
  assert.deepEqual(job.output.models_used.sort(),[primary.model,fallback.model].sort());
  assert.equal(job.output.batches.length,3);
  const batches=(await db.query('SELECT model FROM analysis_batches')).rows;
  assert.equal(batches.filter(b=>b.model===primary.model).length,1);
  assert.equal(batches.filter(b=>b.model===fallback.model).length,2);
  const view=await digest(db,{end:new Date(+NOW+1000)});
  assert.equal(view.items[0].analysis.model,fallback.model);
  assert.equal(view.items[0].analysis.is_current,true);
});

test('primary success does not call fallback; transient failures can switch within the same invocation',async()=>{
  await seed();const primary=mockModel(),fallback=mockModel();
  assert.equal((await run(routed(primary,fallback))).jobs[0].status,'completed');
  assert.equal(fallback.calls.length,0);
  await seed({key:'two'});
  primary.generate=async()=>{throw new ModelError('Rate limit',{status:429,retryAfterMs:120000});};
  const result=await run(routed(primary,fallback),{callLimit:3});
  assert.equal(result.calls,3);assert.equal(result.jobs[0].status,'completed');
  const wait=(await db.query('SELECT * FROM provider_backoff WHERE provider=$1',[`gemini:${primary.model}`])).rows[0];
  assert.ok(+new Date(wait.retry_after)>=+NOW+120000);
});

test('both unavailable models remain queued with durable cooldowns and no repeated calls',async()=>{
  await seed();let attempts=0;
  const primary=mockModel(),fallback=mockModel();
  for (const client of [primary,fallback]) client.generate=async()=>{attempts++;throw new ModelError('Unavailable',{status:503});};
  const pool=routed(primary,fallback);
  assert.equal((await run(pool)).status,'provider_unavailable');assert.equal(attempts,2);
  assert.equal((await run(pool)).status,'provider_unavailable');assert.equal(attempts,2);
  assert.equal((await db.query('SELECT * FROM events')).rows.length,0);
  assert.equal((await db.query('SELECT * FROM provider_backoff')).rows.length,2);
  assert.equal((await db.query("SELECT error_kind FROM processing_jobs WHERE job_type='analyse'")).rows[0].error_kind,'provider_transient');
});

test('a legacy primary cooldown does not block the configured fallback',async()=>{
  await seed();const primary=mockModel(),fallback=mockModel();
  await db.query("INSERT INTO provider_backoff VALUES ('gemini',$1,'Provider temporarily unavailable')",[new Date(+NOW+120000)]);
  assert.equal((await run(routed(primary,fallback))).jobs[0].status,'completed');
  assert.equal(primary.calls.length,0);assert.equal(fallback.calls.length,2);
});

test('a Gemini outage can finish through the Groq adapter with independent cooldown and actual provenance',async()=>{
  await seed({pages:2});const primary=mockModel(),findings=mockModel();
  primary.generate=async()=>{throw new ModelError('Gemini unavailable',{status:503});};
  const groq=new GroqClient({apiKey:'test-key',fetchImpl:async(_url,request)=>{
    const content=JSON.parse(request.body).messages[1].content;
    assert.ok(content.filter(c=>c.type==='image_url').length<=1);
    const text=content[0].text;
    const line=text.indexOf('\n');
    const response=await findings.generate({stage:text.slice(7,line),prompt:text.slice(line+1)});
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response.data)}}]});
  }});
  const pool=new GeminiModels(db,{clients:[primary,groq],clock:()=>NOW});
  const report=await run(pool,{callLimit:4});
  assert.equal(report.jobs[0].status,'completed');assert.equal(report.calls,4);
  assert.deepEqual((await db.query('SELECT provider FROM provider_backoff')).rows.map(r=>r.provider),[`gemini:${primary.model}`]);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.equal(job.output.model,groq.model);assert.deepEqual(job.output.models_used,[groq.model]);
  assert.equal((await alerts(db)).length,1);
});

test('Groq quota cooldown stays independent of a healthy Gemini model',async()=>{
  await seed();const primary=mockModel();
  const groq=new GroqClient({apiKey:'test-key',fetchImpl:async()=>{throw new Error('must remain in cooldown');}});
  await db.query("INSERT INTO provider_backoff VALUES ($1,$2,'Provider rate limit')",[`groq:${groq.model}`,new Date(+NOW+60000)]);
  const pool=new GeminiModels(db,{clients:[groq,primary],clock:()=>NOW});
  assert.equal((await run(pool)).jobs[0].status,'completed');
  assert.equal(primary.calls.length,2);
});

test('a hard Groq request-size limit pauses the job without contaminating Gemini cooldowns',async()=>{
  await seed();
  const groq=new GroqClient({apiKey:'test-key',fetchImpl:async()=>Response.json({error:{message:'Request too large on output tokens per minute'}},{status:429})});
  const pool=new GeminiModels(db,{clients:[groq],clock:()=>NOW});
  assert.equal((await run(pool)).status,'partial');
  assert.equal((await db.query('SELECT * FROM provider_backoff')).rows.length,0);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.equal(job.error_kind,'configuration');
  assert.equal((await run(pool)).calls,0);
});

test('configuration errors and invalid findings never trigger an alternate model',async()=>{
  await seed();const primary=mockModel(),fallback=mockModel();
  primary.generate=async()=>{throw new ModelError('Invalid key',{status:403});};
  assert.equal((await run(routed(primary,fallback))).status,'partial');
  assert.equal(fallback.calls.length,0);
  await db.query("UPDATE processing_jobs SET error_kind=NULL,failure_count=0,next_attempt_at=NULL WHERE job_type='analyse'");
  const invalid=mockModel({transform(data){data.developments[0].evidence[0].quote='invented quote';return data;}});
  assert.equal((await run(routed(invalid,fallback))).jobs[0].status,'failed');
  assert.equal(fallback.calls.length,0);assert.equal((await db.query('SELECT * FROM events')).rows.length,0);
});

test('fallback findings still require valid citations before they can publish',async()=>{
  await seed();const primary=mockModel(),fallback=mockModel({transform(data){data.developments[0].evidence[0].quote='invented quote';return data;}});
  primary.generate=async()=>{throw new ModelError('Timeout',{status:408});};
  assert.equal((await run(routed(primary,fallback))).jobs[0].status,'failed');
  assert.equal((await db.query('SELECT * FROM events')).rows.length,0);
  assert.equal((await alerts(db)).length,0);
});

test('saved analysis stays readable with timestamps while revised and new disclosures are pending',async()=>{
  const disclosure=await seed();await run(mockModel());
  await db.query("UPDATE disclosures SET metadata_hash='revised' WHERE id=$1",[disclosure.id]);
  await db.transaction(tx=>queueAnalysis(tx,disclosure.id,new Date(+NOW+1000)));
  await seed({key:'new-pending',publishedAt:new Date(+NOW+2000)});
  const view=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+3000)});
  const item=view.items.find(i=>i.id===disclosure.id);
  assert.equal(item.processing_status,'queued');assert.equal(item.analysis.available,true);
  assert.equal(item.analysis.is_current,false);assert.ok(item.analysis.analysed_at);
  assert.match(item.analysis.note,/Previously saved/);assert.equal(item.developments.length,1);
  assert.equal(view.saved_company_results.length,1);
  assert.equal(view.saved_company_results[0].input_is_current,false);
  assert.equal(view.saved_company_results[0].pending_disclosures,2);
  const outside=await digest(db,{start:new Date(+NOW+5000),end:new Date(+NOW+6000)});
  assert.equal(outside.items.length,0);assert.equal(outside.saved_company_results.length,1);
});

test('multimodal analysis covers every page, persists evidence and prepares an alert and digest',async()=>{
  await seed({pages:2});const model=mockModel();
  const result=await run(model);
  assert.equal(result.jobs[0].status,'completed');
  assert.equal(model.calls[0].images.length,2);
  assert.ok(model.calls[0].images.every(i=>i.bytes.subarray(1,4).toString()==='PNG'));
  const saved=(await db.query('SELECT * FROM events')).rows[0];
  assert.equal(saved.category,'results');
  assert.equal((await alerts(db)).length,1);
  assert.equal((await alerts(db))[0].delivery_status,'pending');
  assert.equal((await alerts(db))[0].sent_at,null);
  const view=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+1000)});
  assert.equal(view.disclosure_count,1);
  assert.equal(view.items[0].processing_status,'completed');
  assert.equal(view.items[0].developments[0].evidence[0].location.page,1);
  await db.query('DELETE FROM content_blocks');
  const citation=(await db.query('SELECT * FROM event_evidence')).rows[0];
  assert.equal(citation.content_block_id,null);
  assert.match(citation.evidence_snapshot.quote,/1200/);
  const calls=model.calls.length;await digest(db,{hours:36,end:new Date(+NOW+1000)});
  assert.equal(model.calls.length,calls);
});

test('durable page-batch results survive yields without repeating model calls',async()=>{
  await seed();const model=mockModel();
  const first=await run(model,{callLimit:1});assert.equal(first.jobs[0].status,'yielded');
  const second=await run(model,{callLimit:1});assert.equal(second.jobs[0].status,'completed');
  assert.deepEqual(model.calls.map(c=>c.stage),['page_extraction','final_synthesis']);
  assert.equal((await run(model)).jobs.length,0);
});

test('multi-page batches resume without skipping images or reanalysing saved batches',async()=>{
  await seed({pages:3});const model=mockModel();
  let completed=false;
  for(let n=0;n<4;n++){
    const result=await run(model,{callLimit:1,pagesPerBatch:1});
    if(result.jobs[0]?.status==='completed'){completed=true;break;}
  }
  assert.equal(completed,true);
  const pages=model.calls.filter(c=>c.stage==='page_extraction');
  assert.equal(pages.length,3);
  assert.equal(new Set(pages.flatMap(c=>c.images.map(i=>i.blockId))).size,3);
  assert.equal(model.calls.filter(c=>c.stage==='final_synthesis').length,1);
});

test('hierarchical combination preserves page coverage and caches intermediate results',async()=>{
  await seed({pages:3});
  const model=mockModel({transform(data,request){if(request.stage!=='page_extraction') data.developments=data.developments.slice(0,1);return data;}});
  let complete=false;
  for(let n=0;n<8;n++){
    const report=await run(model,{pagesPerBatch:1,callLimit:2,maxSynthesisChars:2000});
    if(report.jobs[0]?.status==='completed'){complete=true;break;}
    assert.notEqual(report.jobs[0]?.status,'failed',JSON.stringify(report));
  }
  assert.equal(complete,true);
  assert.ok(model.calls.some(c=>c.stage==='combine_batches'));
  assert.equal(model.calls.filter(c=>c.stage==='page_extraction').length,3);
  const output=(await db.query("SELECT output FROM processing_jobs WHERE job_type='analyse'")).rows[0].output;
  assert.equal(output.result.covered_block_ids.length,3);
});

test('repeated disclosure links to existing event without sending a duplicate alert',async()=>{
  await seed();await run(mockModel());
  await seed({key:'repeat',publishedAt:new Date(+NOW+3600000)});
  await run(mockModel(),{clock:()=>new Date(+NOW+3600000)});
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n),1);
  assert.equal((await alerts(db)).length,1);
  const later=await digest(db,{start:new Date(+NOW+1800000),end:new Date(+NOW+7200000)});
  assert.equal(later.disclosure_count,1);
  assert.equal(later.items[0].developments[0].relationship,'repeated');
});

test('a correction advances event version and numerical history and generates an update alert',async()=>{
  await seed();await run(mockModel());
  await seed({key:'correction',value:1250,publishedAt:new Date(+NOW+3600000)});
  await run(mockModel({relationship:'correction'}),{clock:()=>new Date(+NOW+3600000)});
  assert.equal((await db.query('SELECT version FROM events')).rows[0].version,2);
  const values=(await db.query("SELECT value,is_current FROM observations WHERE metric='revenue' ORDER BY revision")).rows;
  assert.deepEqual(values.map(v=>[Number(v.value),v.is_current]),[[1200,false],[1250,true]]);
  assert.equal((await alerts(db)).length,2);
});

test('invented text quotations and uncited numerical values are rejected',async()=>{
  await seed();
  const bad=mockModel({transform(data){data.developments[0].evidence[0].quote='Unsupported invented quote';return data;}});
  const report=await run(bad);assert.equal(report.jobs[0].status,'failed');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n),0);
  await db.query("UPDATE processing_jobs SET status='queued',next_attempt_at=NULL");
  const wrong=mockModel({transform(data){data.developments[0].observations[0].value=9999;return data;}});
  assert.equal((await run(wrong)).jobs[0].status,'failed');
  assert.equal((await alerts(db)).length,0);
});

test('incorrect page coverage and invented prior-event IDs cannot be accepted',async()=>{
  await seed({pages:2});
  const model=mockModel({transform(data){data.covered_block_ids=[];return data;}});
  assert.equal((await run(model)).jobs[0].status,'failed');
  await db.query("UPDATE processing_jobs SET status='queued',next_attempt_at=NULL WHERE job_type='analyse'");
  const foreign=mockModel({transform(data){data.developments[0].matched_event_id=randomUUID();data.developments[0].relationship='repeated';return data;}});
  assert.equal((await run(foreign)).jobs[0].status,'failed');
});

test('quota failures require manual retry after the reset and reuse completed batches',async()=>{
  await seed();
  const model=mockModel();const generate=model.generate.bind(model);
  model.generate=async request=>{if(request.stage==='final_synthesis') throw new ModelError('Gemini request failed (HTTP 429)',{status:429,retryAfterMs:120000});return generate(request);};
  assert.equal((await run(model)).status,'rate_limited');
  const retry=mockModel();
  assert.equal((await run(retry,{clock:()=>new Date(+NOW+30000)})).status,'rate_limited');
  assert.equal(retry.calls.length,0);
  assert.equal((await run(retry,{clock:()=>new Date(+NOW+121000)})).jobs.length,0);
  await db.query("UPDATE processing_jobs SET error_kind=NULL,next_attempt_at=NULL,failure_count=0 WHERE error_kind='quota_limit'");
  assert.equal((await run(retry,{clock:()=>new Date(+NOW+121000)})).jobs[0].status,'completed');
  assert.deepEqual(retry.calls.map(c=>c.stage),['final_synthesis']);
});

test('provider overload pauses the whole queue and resumes even after repeated transient failures',async()=>{
  await seed();
  const unavailable=mockModel();
  unavailable.generate=async()=>{throw new ModelError('Model is experiencing high demand',{status:503});};
  const result=await run(unavailable);
  assert.equal(result.status,'provider_unavailable');
  assert.equal((await db.query("SELECT error_kind FROM processing_jobs WHERE job_type='analyse'")).rows[0].error_kind,'provider_transient');
  const healthy=mockModel();
  assert.equal((await run(healthy,{clock:()=>new Date(+NOW+30000)})).status,'provider_unavailable');
  assert.equal(healthy.calls.length,0);
  await db.query("UPDATE processing_jobs SET failure_count=8,next_attempt_at=$1 WHERE job_type='analyse'",[NOW]);
  await db.query("UPDATE provider_backoff SET retry_after=$1",[NOW]);
  assert.equal((await run(healthy,{clock:()=>new Date(+NOW+62000)})).jobs[0].status,'completed');
});

test('non-retryable provider configuration errors require an explicit operator retry',async()=>{
  await seed();
  const invalid=mockModel();invalid.generate=async()=>{throw new ModelError('Permission denied',{status:403});};
  await run(invalid);
  const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
  assert.equal(job.error_kind,'configuration');assert.equal(job.next_attempt_at,null);
  const valid=mockModel();
  assert.equal((await run(valid,{clock:()=>new Date(+NOW+86400000)})).jobs.length,0);
  assert.equal(valid.calls.length,0);
  await db.query("UPDATE processing_jobs SET error_kind=NULL,failure_count=0,next_attempt_at=NULL WHERE id=$1",[job.id]);
  assert.equal((await run(valid)).jobs[0].status,'completed');
});

test('superseded input rejects model output before it can create events',async()=>{
  await seed();
  const model=mockModel({afterGenerate:async(_data,request)=>{if(request.stage==='final_synthesis') await db.query("UPDATE disclosures SET metadata_hash='changed-input'");}});
  assert.equal((await run(model)).jobs[0].status,'superseded_or_lease_lost');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n),0);
});

test('missing derived images requeue extraction without publishing partial analysis',async()=>{
  await seed({pages:1});
  const block=(await db.query('SELECT * FROM content_blocks')).rows[0];
  await files.remove(block.temporary_image_path);
  const model=mockModel();
  const report=await run(model);
  assert.equal(report.jobs[0].status,'awaiting_regenerated_images');
  assert.equal(model.calls.length,0);
  assert.equal((await db.query("SELECT status FROM processing_jobs WHERE job_type='extract'")).rows[0].status,'queued');
  assert.equal((await db.query('SELECT extraction_status FROM assets')).rows[0].extraction_status,'pending');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n),0);
});

test('expired analysis ownership cannot save a late batch',async()=>{
  await seed();
  const old=await claimAnalysis(db,NOW,'gemini-3.8-flash');
  const later=new Date(+NOW+301000);
  const fresh=await claimAnalysis(db,later,'gemini-3.8-flash');
  assert.notEqual(fresh.lease_token,old.lease_token);
  const batch={key:'test-batch',stage:'map',data:{},usage:null};
  assert.equal(await saveBatch(db,old,batch,later),false);
  assert.equal(await saveBatch(db,fresh,batch,later),true);
});

test('visual citations keep their image reference and explicit visual provenance',async()=>{
  await seed({pages:2});
  const model=mockModel({transform(data,request){
    if(request.stage==='page_extraction'){
      const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1));
      data.developments[0].evidence.push({block_id:source.pages[1].block_id,modality:'visual',quote:'A chart is shown on this page'});
    }
    return data;
  }});
  await run(model);
  const evidence=(await db.query('SELECT * FROM event_evidence WHERE retained_image_path IS NOT NULL')).rows[0];
  assert.ok(await files.exists(evidence.retained_image_path));
  assert.equal(evidence.evidence_snapshot.modality,'visual');
  assert.equal(evidence.evidence_snapshot.location.page,2);
});

test('a disclosure can create multiple developments without losing its source entry',async()=>{
  await seed();
  const model=mockModel({transform(data,request){
    if(request.stage==='page_extraction'){
      const second=structuredClone(data.developments[0]);
      second.category='routine';second.headline='Publication of quarterly statement';second.importance='routine';second.observations=[];
      data.developments.push(second);
    }
    return data;
  }});
  await run(model);
  const view=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+1000)});
  assert.equal(view.disclosure_count,1);assert.equal(view.items[0].developments.length,2);
  assert.equal((await alerts(db)).length,1);
});

test('older disclosures cannot overwrite newer reported values or event versions',async()=>{
  await seed({key:'newer',value:1250,publishedAt:new Date(+NOW+3600000)});
  await run(mockModel(),{clock:()=>new Date(+NOW+3600000)});
  await seed({key:'older',value:1200,publishedAt:NOW});
  await run(mockModel({relationship:'correction'}),{clock:()=>new Date(+NOW+7200000)});
  assert.equal(Number((await db.query("SELECT value FROM observations WHERE metric='revenue' AND is_current")).rows[0].value),1250);
  assert.equal((await db.query('SELECT version FROM events')).rows[0].version,1);
  assert.equal((await alerts(db)).length,1);
});

test('routine and pending disclosures remain accounted for in any digest window',async()=>{
  await seed({key:'routine'});
  const routine=mockModel({transform(data){const d=data.developments[0];d.category='routine';d.importance='routine';d.observations=[];return data;}});
  await run(routine);
  await seed({key:'pending',publishedAt:new Date(+NOW+1000)});
  const result=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+2000)});
  assert.equal(result.disclosure_count,2);
  assert.equal(result.routine_collapsed.length,1);
  assert.ok(result.items.some(i=>i.processing_status==='queued'));
  assert.equal((await alerts(db)).length,0);
});

test('unsupported assets remain explicit incomplete coverage in stored findings and digests',async()=>{
  const disclosure=await seed({pages:1});
  await db.query("DELETE FROM processing_jobs WHERE job_type='analyse'");
  await db.query("UPDATE assets SET extraction_status='unsupported',extraction_error='Unsupported attachment format'");
  await db.transaction(tx=>queueAnalysis(tx,disclosure.id,NOW));
  const report=await run(mockModel());
  assert.equal(report.jobs[0].status,'completed');
  const output=(await db.query("SELECT output FROM processing_jobs WHERE job_type='analyse'")).rows[0].output;
  assert.equal(output.coverage.complete,false);
  assert.ok(output.result.limitations.some(l=>l.includes('Unsupported attachment')));
  const view=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+1000)});
  assert.ok(view.items[0].limitations.length);
});

test('QoQ and YoY use matching scope, units, and reporting periods',async()=>{
  await seed({key:'previous-quarter',value:1000,period:'2026-06-30'});await run(mockModel());
  await seed({key:'previous-year',value:800,period:'2025-09-30'});await run(mockModel());
  await seed({key:'current',value:1200});await run(mockModel());
  const event=(await db.query("SELECT * FROM events WHERE title='Quarterly results 2026-09-30'")).rows[0];
  const revenue=event.details.financials[0].figures.find(f=>f.metric==='revenue');
  assert.ok(Math.abs(revenue.qoq.change_percent-20)<1e-8);
  assert.equal(revenue.yoy.change_percent,50);
  assert.equal(event.details.financials[0].figures.find(f=>f.metric==='ebitda').status,'unavailable');
});

test('overlapping comparison columns cannot merge two different quarterly results events',async()=>{
  await seed({key:'june',value:1000,period:'2026-06-30'});await run(mockModel());
  await seed({key:'september',value:1200,extraText:' Previous quarter revenue 1000 INR crore.'});
  const model=mockModel({transform(data,request){
    if(request.stage==='page_extraction') data.developments[0].observations.push({...data.developments[0].observations[0],value:1000,period_start:'2026-04-01',period_end:'2026-06-30'});
    else {
      const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1));
      data.developments[0].matched_event_id=source.previous_events[0].id;
      data.developments[0].relationship='update';data.developments[0].change_reason='Attempted wrong-period match';
    }
    return data;
  }});
  assert.equal((await run(model)).jobs[0].status,'failed');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM events')).rows[0].n),1);
});

test('Gemini adapter uses selected model, private key header and multimodal structured output',async()=>{
  let payload;
  const client=new GeminiClient({apiKey:'test-secret',model:'gemini-3.6-flash',fetchImpl:async(url,options)=>{
    assert.ok(!url.includes('test-secret'));assert.equal(options.headers['x-goog-api-key'],'test-secret');
    payload=JSON.parse(options.body);
    assert.ok(!options.body.includes('test-secret'));
    return new Response(JSON.stringify({status:'completed',outputs:[{type:'text',text:'{"covered_block_ids":[],"developments":[],"limitations":[]}'}]}),{status:200});
  }});
  await client.generate({stage:'page_extraction',prompt:'source',images:[{blockId:randomUUID(),bytes:Buffer.from('png'),mimeType:'image/png'}]});
  assert.equal(payload.model,'gemini-3.6-flash');assert.equal(payload.store,false);
  assert.ok(payload.input.some(i=>i.type==='image'));assert.ok(payload.response_format.schema);
  const denied=new GeminiClient({apiKey:'test-secret',fetchImpl:async()=>new Response('test-secret',{status:429,headers:{'retry-after':'120'}})});
  await assert.rejects(()=>denied.generate({stage:'test',prompt:'test'}),e=>e.status===429 && e.retryAfterMs===120000 && !e.message.includes('test-secret'));
});

test('EOD thresholds use prior sessions, stay configurable, and deduplicate delivery candidates',async()=>{
  const company=(await db.query('SELECT id FROM companies')).rows[0];
  for(let n=0;n<21;n++){
    const date=new Date(+NOW-(21-n)*86400000).toISOString().slice(0,10);
    for(const [metric,value] of [['close',n===20?106:100],['volume',n===20?3000:1000]])
      await db.query(`INSERT INTO observations(id,company_id,metric,value,unit,period_start,period_end,frequency,scope,source_url,evidence_snapshot,collected_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6,'daily','market','https://source.example',$7,$8)`,
      [randomUUID(),company.id,metric,value,metric==='volume'?'shares':'INR/share',date,'{}',NOW]);
  }
  assert.equal(await evaluateMarketAlerts(db,NOW),2);
  assert.equal(await evaluateMarketAlerts(db,NOW),0);
  const volume=(await alerts(db)).find(a=>a.trigger_details.metric==='volume');
  assert.equal(volume.trigger_details.baseline,1000);
  assert.equal(volume.trigger_details.observed_change,3);
  await configureRule(db,'price_move',{percent:10});
  assert.equal((await alerts(db)).length,2); // Existing history remains intact.
  const view=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+1000)});
  assert.equal(view.alerts_created_in_window.length,2);
  assert.equal(view.latest_market_snapshot.length,2);
  assert.ok(view.latest_market_snapshot.every(row=>row.session_date));
});

test('zero or negative comparison bases never produce misleading growth percentages',async()=>{
  await seed({key:'zero-base',value:0,period:'2026-06-30'});await run(mockModel());
  await seed({key:'current',value:1200});await run(mockModel());
  const event=(await db.query("SELECT * FROM events WHERE title='Quarterly results 2026-09-30'")).rows[0];
  const revenue=event.details.financials[0].figures.find(f=>f.metric==='revenue');
  assert.equal(revenue.qoq.change_percent,null);
  assert.equal(revenue.qoq.status,'zero_or_negative_base');
});

test('read and worker endpoints reject unauthorised requests before accessing data',async()=>{
  for(const handler of [analyseHandler,digestHandler,alertsHandler]){
    const response={setHeader(){},status(code){this.code=code;return this;},json(value){return value;}};
    await handler({method:'GET',headers:{},query:{}},response);
    assert.equal(response.code,401);
  }
  await assert.rejects(()=>digest(db,{start:'2026-11-12T00:00:00',end:'2026-11-13T00:00:00'}),/timezone/);
});

test('large monitoring filings publish in two calls with explicit selected-page coverage',async()=>{
 await seed({pages:40});const model=mockModel();
 const result=await run(model,{callLimit:2,budgetMs:45000});
 assert.equal(result.jobs[0].status,'completed');assert.equal(result.calls,2);
 assert.equal(model.calls[0].images.length,1);
 const saved=(await db.query("SELECT output FROM processing_jobs WHERE job_type='analyse'")).rows[0].output;
 assert.equal(saved.coverage.indexed_pages,40);assert.equal(saved.coverage.analysed_all_prepared_pages,false);
 assert.ok(saved.coverage.selected_pages<40);
 const d=await digest(db,{start:new Date(+NOW-1000),end:new Date(+NOW+1000)});
 assert.equal(d.items.length,1);assert.equal(d.items[0].analysis.coverage.indexed_pages,40);
 assert.ok(d.items[0].limitations.some(l=>l.includes('Selected passages')));
});

test('quota exhaustion at the call budget pauses analysis rather than yielding an automatic retry',async()=>{
 await seed();const {AnalysisModels}=await import('../analysis/models.js');
 const clients=[{model:'primary',credentialScope:'a'},{model:'primary',credentialScope:'b',keySlot:'secondary'},{model:'fallback',credentialScope:'a'}].map(c=>({...c,provider:'gemini',generate:async()=>{throw new ModelError('Daily request limit',{status:429,retryAfterMs:3600000});}}));
 const result=await run(new AnalysisModels(db,{clients,clock:()=>NOW}),{callLimit:2});
 assert.equal(result.jobs[0].status,'failed');
 const job=(await db.query("SELECT * FROM processing_jobs WHERE job_type='analyse'")).rows[0];
 assert.equal(job.error_kind,'quota_limit');assert.equal(job.next_attempt_at,null);assert.ok(job.output.quota_retry_at);
});

test('numbered text citations publish exact saved source text without model retyping and survive synthesis',async()=>{
 await seed({pages:1});
 const model=mockModel({transform(data,request){
  if(request.stage==='page_extraction'){
   const source=JSON.parse(request.prompt.slice(request.prompt.indexOf('\n')+1));
   const reference=source.pages[0].text.match(/\[(finn-text:[^\]]+)\]/)[1];
   data.developments[0].evidence[0].quote=reference;
  }return data;
 }});
 const report=await run(model);assert.equal(report.jobs[0].status,'completed');assert.equal(report.calls,2);
 const evidence=(await db.query('SELECT evidence_snapshot FROM event_evidence')).rows[0].evidence_snapshot;
 assert.ok(JSON.stringify(evidence).includes('Revenue 1200 INR crore'));assert.ok(!JSON.stringify(evidence).includes('finn-text:'));
 assert.equal((await alerts(db)).length,1);
});

test('unknown or wrong-page text references cannot bypass grounding or publish alerts',async()=>{
 await seed({pages:1});
 const model=mockModel({transform(data,request){if(request.stage==='page_extraction')data.developments[0].evidence[0].quote='finn-text:unknown:1';return data;}});
 const report=await run(model);assert.equal(report.jobs[0].status,'failed');assert.match(report.jobs[0].error,/Unknown or mismatched/);
 assert.equal((await db.query('SELECT * FROM analysis_batches')).rows.length,0);assert.equal((await alerts(db)).length,0);
 const {textCitations}=await import('../analysis/text-citations.js');
 const a=randomUUID(),b=randomUUID(),refs=textCitations([{id:a,content:{text:'Original exact words'}},{id:b,content:{text:'Another page'}}]);
 assert.throws(()=>refs.resolve({developments:[{evidence:[{modality:'text',block_id:b,quote:`finn-text:${a}:1`}]}]}),/mismatched/);
});

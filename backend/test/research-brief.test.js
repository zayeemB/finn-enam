import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {openDatabase} from '../db.js';
import {localFiles} from '../files.js';
import {initialiseApp} from '../app-state.js';
import {createResearch,researchJob} from '../research/jobs.js';
import {research} from '../research/worker.js';
import {selectPages,validateBrief,limits,profiles} from '../research/brief.js';
import {numericTokens} from '../research/numbers.js';
import {ModelError} from '../analysis/gemini.js';

let db,folder,files;
before(async()=>{db=await openDatabase({memory:true,connectionString:''});});
after(async()=>db.close());
beforeEach(async()=>{await db.query('TRUNCATE portfolios,companies,provider_backoff CASCADE');await initialiseApp(db);folder=await mkdtemp(join(tmpdir(),'finn-brief-test-'));files=localFiles(folder);});
afterEach(async()=>rm(folder,{recursive:true,force:true}));
async function prepared(){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=32;n++)pdf.addPage([500,300]).drawText(n===27?'Consolidated statement of cash flows. Cash from operations INR 100 crore in FY2025-26.':'Company operating information for this report and financial year. Corporate governance and general shareholder information.',{font,x:10,y:200,size:10,maxWidth:480});
  const bytes=Buffer.from(await pdf.save()),job=await createResearch(db,{symbol:'TEST',question:'Explain cash from operations.'});
  const options={budgetMs:120000,discoverSources:async()=>({documents:[{kind:'annual_report',title:'Annual report',source_url:'https://www.bseindia.com/test.pdf',discovery_url:'https://www.screener.in/company/TEST/'}],allowedHosts:[]}),clientFactory:()=>({get:async()=>({body:bytes})})};
  await research(db,files,options);await research(db,files,options);
  return {job,options};
}
test('the default entry point indexes a whole PDF and produces a cited brief in one bounded model call',async()=>{
  const {job,options}=await prepared();let calls=0;
  const model={model:'test-model',generate:async request=>{
    calls++;assert.ok(request.timeoutMs<=limits.requestMs);assert.equal(request.maxOutputTokens,4500);assert.ok(request.images.length<=limits.images);
    const input=JSON.parse(request.prompt),page=input.evidence.find(p=>p.page===27);
    assert.ok(page);
    return {model:'test-model',data:{title:'Cash conversion',sections:[{topic:'cash_quality',findings:[{statement:'Cash from operations was INR 100 crore in FY2025-2026.',citations:[{source_id:page.passages[0].id,quote:''}]}]}],limitations:[]}};
  }};
  const result=await research(db,files,{...options,model});
  assert.equal(result.status,'completed',result.error);assert.equal(calls,1);
  const saved=await researchJob(db,job.id);
  assert.equal(saved.result.report_type,'focused_brief');
  assert.equal(saved.result.coverage.indexed_pages,32);
  assert.ok(saved.result.coverage.source_characters<=limits.characters);
  assert.equal(saved.documents[0].prepared_pages,32);
  assert.equal(saved.documents[0].reviewed_pages,saved.result.coverage.selected_pages);
  assert.equal(saved.research_state.calls,1);
  assert.equal(saved.evidence.length,1);assert.match(saved.evidence[0].evidence_snapshot.quote,/100 crore/);
  const images=Number((await db.query('SELECT count(*) AS n FROM content_blocks WHERE temporary_image_path IS NOT NULL')).rows[0].n);
  assert.equal(images,limits.images);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM processing_jobs')).rows[0].n),0);
  const next=await createResearch(db,{symbol:'TEST',question:'Explain cash generation and working capital.'});
  const noDownload={...options,clientFactory:()=>({get(){throw new Error('PDF should have been reused');}})};
  await research(db,files,noDownload);await research(db,files,noDownload);
  assert.equal((await research(db,files,{...noDownload,model})).status,'completed');
  assert.equal((await researchJob(db,next.id)).result.report_type,'focused_brief');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM content_blocks')).rows[0].n),32);

});
test('quota exhaustion preserves sources and requires a user retry even after reset time',async()=>{
  const {job,options}=await prepared();let calls=0;
  const result=await research(db,files,{...options,model:{generate(){calls++;throw new ModelError('Daily quota exceeded',{status:429,retryAfterMs:36000000});}}});
  const saved=await researchJob(db,job.id);
  assert.equal(result.status,'failed');assert.equal(calls,1);
  assert.equal(saved.result,null);
  assert.equal(saved.next_attempt_at,null);
  assert.equal(saved.error_kind,'quota_limit');
  assert.ok(+new Date(saved.research_state.quota_retry_at)>Date.now()+35900000);
  assert.ok(saved.documents[0].prepared_pages>0);
  assert.equal((await research(db,files,{...options,clock:()=>new Date(Date.now()+72000000),model:{generate(){throw new Error('must not run');}}})).status,'idle');
});
test('invalid model replies consume only two corrective attempts before producing source excerpts',async()=>{
  const {job,options}=await prepared();let calls=0;
  await research(db,files,{...options,model:{generate(){calls++;return {data:{bad:true}};}}});
  const saved=await researchJob(db,job.id);
  assert.equal(calls,2);assert.equal(saved.research_state.calls,2);assert.equal(saved.status,'partial');
});
test('unknown references and invented figures are excluded while supported findings survive',()=>{
  const sources=new Map([['p1.1',{text:'Cash was INR 100 crore in FY2025-2026.',page:{id:'block',document:{title:'Annual'}}}]]);
  const good={statement:'Cash was INR 100 crore in FY2025-26.',citations:[{source_id:'p1.1',quote:''}]};
  const result=validateBrief({title:'Brief',sections:[{topic:'cash_quality',findings:[good,{...good,statement:'Cash was INR 999 crore.'},{statement:'Revenue grew.',citations:[{source_id:'missing',quote:''}]}]}],limitations:[]},sources);
  assert.equal(result.facts.length,1);assert.equal(result.dropped.length,2);
  assert.deepEqual(numericTokens('FY2025-26'),numericTokens('FY2025-2026'));
});
test('retrieval finds cash statements near the end and reserves evidence from each source',()=>{
  const pages=Array.from({length:150},(_,i)=>({id:'a'+i,sequence:i+1,text:i===140?'Consolidated statement of cash flows. Cash generated from operations and net debt.':'Corporate operations and governance.',document:{id:'annual'}}));
  pages.push({id:'t1',sequence:1,text:'Management explained cash flow and working capital.',document:{id:'transcript'}});
  const selected=selectPages(pages,'Do profits turn into cash?');
  assert.ok(selected.some(p=>p.id==='a140'));assert.ok(selected.some(p=>p.id==='t1'));assert.ok(selected.length<=profiles.compact.pages);
});
test('the research transport sends schema and images through generateContent and rejects truncated replies',async()=>{
  const {GeminiClient}=await import('../analysis/gemini.js');
  let finish='STOP';
  const client=new GeminiClient({apiKey:'test-secret',model:'gemini-3.5-flash-lite',transport:'generateContent',fetchImpl:async(url,request)=>{
    assert.match(url,/models\/gemini-3.5-flash-lite:generateContent$/);
    const body=JSON.parse(request.body);assert.equal(body.generationConfig.maxOutputTokens,4500);
    assert.equal(body.contents[0].parts[2].inlineData.mimeType,'image/png');
    assert.ok(body.generationConfig.responseJsonSchema);
    return Response.json({candidates:[{finishReason:finish,content:{parts:[{text:'{"ok":true}'}]}}]});
  }});
  const request={stage:'research_brief',prompt:'Evidence',systemInstruction:'Return JSON',responseSchema:{type:'object'},images:[{blockId:'p1',bytes:Buffer.from('png'),mimeType:'image/png'}],maxOutputTokens:4500};
  assert.deepEqual((await client.generate(request)).data,{ok:true});
  finish='MAX_TOKENS';await assert.rejects(()=>client.generate(request),/did not complete/);
});
test('table header periods can be copied from a neighbouring passage on the cited page',()=>{
  const page={id:'b',document:{title:'Annual'}};
  const sources=new Map([['p1.1',{text:'Operating cash flow was 100 crore.',page}],['p1.2',{text:'For the year 2025-2026.',page}]]);
  const result=validateBrief({title:'Cash',sections:[{topic:'cash_quality',findings:[{statement:'Operating cash flow was 100 crore in FY2025-26.',citations:[{source_id:'p1.1',quote:''}]}]}],limitations:[]},sources);
  assert.equal(result.facts[0].evidence.length,2);
  assert.equal(result.dropped.length,0);
});
test('a research request without a prompt gets the broad assignment-aligned overview',async()=>{
  const job=await createResearch(db,{symbol:'TEST'});
  const saved=await researchJob(db,job.id);
  for(const phrase of ['business','financial snapshot','cash conversion','guidance','governance'])assert.ok(saved.question.includes(phrase));
});
test('passage selection preserves exact quotations while spreading a fixed budget across topics',async()=>{
  const {passagesFor,OVERVIEW_QUESTION,profiles}=await import('../research/brief.js');
  const pages=Array.from({length:10},(_,i)=>({id:'p'+i,sequence:i+1,document:{id:'annual'},text:('Business overview financial highlights cash flow from operating activities guidance and capital expenditure. '+i+' ').repeat(150)}));
  const selected=selectPages(pages,OVERVIEW_QUESTION,{strategy:'passages',profile:profiles.balanced});
  const passages=selected.flatMap((p,i)=>passagesFor(p,'p'+i));
  assert.ok(passages.reduce((n,p)=>n+p.text.length,0)<=profiles.balanced.characters);
  assert.ok(passages.every(p=>p.page.text.includes(p.text)));
});
for(const mode of ['success','outage','restart','quota'])test('adaptive research saves initial work and handles expansion '+mode,async()=>{
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=40;n++){
    const text=n===40?'Cobalt settlement guarantees are disclosed in the lease note. ':('Company operations and services described for this financial period. ');
    pdf.addPage([500,600]).drawText(text.repeat(18),{font,x:10,y:560,size:9,maxWidth:480});
  }
  const job=await createResearch(db,{symbol:'ADAPT',question:'Explain company services.'});
  const body=Buffer.from(await pdf.save());
  const options={budgetMs:120000,discoverSources:async()=>({documents:[{kind:'annual_report',title:'Annual',source_url:'https://www.bseindia.com/adapt.pdf',discovery_url:'https://www.screener.in/company/ADAPT/'}],allowedHosts:[]}),clientFactory:()=>({get:async()=>({body})})};
  await research(db,files,options);await research(db,files,options);
  const requests=[];
  const model={model:'test',async generate(request){
    const input=JSON.parse(request.prompt);requests.push(input);
    const expansion=request.stage==='research_expansion';
    if(expansion){
      const saved=await researchJob(db,job.id);
      assert.ok(saved.result);assert.equal(saved.status,'running');
      assert.ok(input.prior_findings.length);assert.ok(!JSON.stringify(input.evidence).includes('"id":"p1.'));
    }
    if(expansion&&mode==='outage')throw new ModelError('Busy',{status:503});
    if(expansion&&mode==='quota'&&requests.length===2)throw new ModelError('Daily quota exceeded',{status:429,retryAfterMs:36000000});
    if(expansion&&mode==='restart'&&requests.length===2){
      await db.query("UPDATE research_jobs SET lease_expires_at=$2 WHERE id=$1",[job.id,new Date(0)]);
      throw new Error('Research lease lost');
    }
    const page=expansion?input.evidence.find(p=>p.passages.some(s=>s.text.includes('Cobalt'))):input.evidence[0];
    assert.ok(page);
    return {data:{title:'Services',sections:[{topic:expansion?'balance_sheet':'business_snapshot',findings:[{
      statement:expansion?'Cobalt settlement guarantees are disclosed.':'The company describes its services.',
      citations:[{source_id:page.passages[0].id,quote:''}]}]}],limitations:[],
      gaps:expansion?[]:[{topic:'balance_sheet',question:'What are the cobalt settlement guarantees?'}]}};
  }};
  let done=await research(db,files,{...options,model});
  if(mode==='restart'){
    assert.equal(done.status,'lease_lost');
    done=await research(db,files,{...options,model});
    assert.equal(requests.length,3);
    assert.equal(requests.filter(r=>!r.prior_findings).length,1);
  }else assert.equal(requests.length,2);
  assert.equal(done.status,mode==='quota'?'failed':'completed',done.error);
  const saved=await researchJob(db,job.id);
  const interrupted=mode==='outage'||mode==='quota';
  assert.equal(saved.result.adaptive.added_findings,interrupted?0:1);
  assert.equal(saved.result.adaptive.passes,interrupted?1:2);
  assert.equal(saved.result.sections.length,interrupted?1:2);
  assert.ok(saved.result.limitations.find(l=>l.startsWith('Selected passages from')).includes(String(saved.result.coverage.selected_pages)));
  assert.ok(saved.result.coverage.selected_pages>8);
  assert.equal(saved.research_state.calls,mode==='restart'?3:2);
  if(mode==='quota'){
    assert.equal(saved.error_kind,'quota_limit');assert.equal(saved.next_attempt_at,null);
    assert.ok(saved.research_state.quota_retry_at);
    assert.equal((await research(db,files,{...options,model})).status,'idle');
    await db.query("UPDATE research_jobs SET status='queued',error_kind=NULL,research_state=research_state - 'brief_started_at' - 'calls' WHERE id=$1",[job.id]);
    assert.equal((await research(db,files,{...options,model})).status,'completed');
    assert.equal(requests.filter(r=>!r.prior_findings).length,1);
  }
});
test('research quality strips internal markers before numeric checks and classifies capital distributions',()=>{
  const page={id:'b',document:{title:'Annual'}};
  const sources=new Map([['p1.1',{text:'Operating cash flow was INR 100 crore in FY2025-26. A bonus NCRPS distribution is proposed.',page}]]);
  const result=validateBrief({title:'Quality',sections:[
    {topic:'cash_quality',findings:[{statement:'Operating cash flow was INR 100 crore in FY2025-26 [p1.1].',citations:[{source_id:'p1.1',quote:''}]}]},
    {topic:'guidance',findings:[{statement:'A bonus NCRPS distribution is proposed.',citations:[{source_id:'p1.1',quote:''}]}]},
  ],limitations:[]},sources);
  assert.equal(result.dropped.length,0);
  assert.ok(!result.facts[0].fact.includes('[p1'));
  assert.ok(result.sections.some(s=>s.topic==='capital_allocation'));
  assert.ok(!result.sections.some(s=>s.topic==='guidance'));
});
test('unsupported section interpretations become evidence gaps while supported facts remain visible',()=>{
  const page={id:'b',document:{title:'Annual'}};
  const sources=new Map([['p1.1',{text:'The company has lean inventory. Management discussed commodity prices. EBCO inventory challenges persisted. Revenue was 100.',page}]]);
  const finding=statement=>({statement,citations:[{source_id:'p1.1',quote:''}]});
  const result=validateBrief({title:'Quality',sections:[
    {topic:'cash_quality',findings:[finding('The company uses lean inventory practices.')]},
    {topic:'narrative_vs_numbers',findings:[finding('Management discussed commodity prices.')]},
    {topic:'bull_vs_bear',findings:[finding('The EBCO subsidiary has inventory challenges.')]},
    {topic:'financial_snapshot',findings:[finding('Revenue was 100.')]},
  ],limitations:[]},sources);
  assert.ok(!result.sections.some(s=>s.topic==='cash_quality'||s.topic==='narrative_vs_numbers'||s.topic==='bull_vs_bear'));
  assert.ok(result.gaps.length>=3);
});

test('GDP forecasts and commentary without numerical outcomes do not pass as company guidance or analysis',async()=>{
 const {sectionQuality,cleanStatement}=await import('../research/quality.js');
 assert.equal(sectionQuality('guidance','GDP growth is expected to reach 6%.',[]).topic,undefined);
 assert.equal(sectionQuality('narrative_vs_numbers','Management expects demand in FY2025-26, which aligns with cash generation.',[]).topic,undefined);
 assert.equal(cleanStatement('A supported fact [p3.visual, p2.1].'),'A supported fact.');
});
test('Gemini quota fallback uses the secondary key with independent cooldowns for the same model',async()=>{
 const {GeminiClient}=await import('../analysis/gemini.js'),{AnalysisModels}=await import('../analysis/models.js');
 const calls=[];
 const fetchImpl=async(_url,request)=>{
   const key=request.headers['x-goog-api-key'];calls.push(key);
   if(key==='fake-primary')return Response.json({error:{message:'Request limit reached. Please retry in 1h.'}},{status:429});
   return Response.json({status:'completed',output_text:'{"ok":true}'});
 };
 const clients=[new GeminiClient({apiKey:'fake-primary',model:'test',fetchImpl}),new GeminiClient({apiKey:'fake-secondary',keySlot:'secondary',model:'test',fetchImpl})];
 const router=new AnalysisModels(db,{clients});
 assert.deepEqual((await router.generate({stage:'test',prompt:'test'})).data,{ok:true});
 assert.deepEqual((await router.generate({stage:'test',prompt:'test'})).data,{ok:true});
 assert.deepEqual(calls,['fake-primary','fake-secondary','fake-secondary']);
 const rows=(await db.query('SELECT * FROM provider_backoff')).rows;
 assert.equal(rows.length,1);assert.ok(!rows[0].provider.includes('fake-primary'));
});
test('secondary Gemini key is reserved for request limits',async()=>{
 const {GeminiClient}=await import('../analysis/gemini.js'),{AnalysisModels}=await import('../analysis/models.js');
 let secondaryCalls=0;
 const primary=new GeminiClient({apiKey:'fake-primary',model:'test',fetchImpl:async()=>Response.json({error:{message:'Busy'}},{status:503})});
 const secondary=new GeminiClient({apiKey:'fake-secondary',keySlot:'secondary',model:'test',fetchImpl:async()=>{secondaryCalls++;}});
 await assert.rejects(()=>new AnalysisModels(db,{clients:[primary,secondary]}).generate({stage:'test',prompt:'test'}),/cooling down/);
 assert.equal(secondaryCalls,0);
});

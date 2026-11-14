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
import {selectPages,validateBrief,limits} from '../research/brief.js';
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
  assert.equal(result.status,'completed');assert.equal(calls,1);
  const saved=await researchJob(db,job.id);
  assert.equal(saved.result.report_type,'focused_brief');
  assert.equal(saved.result.coverage.indexed_pages,32);
  assert.ok(saved.result.coverage.selected_pages<=24);
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
test('provider outages finish with labeled source excerpts and no automatic retry loop',async()=>{
  const {job,options}=await prepared();let calls=0;
  const result=await research(db,files,{...options,model:{generate(){calls++;throw new ModelError('Busy',{status:503});}}});
  const saved=await researchJob(db,job.id);
  assert.equal(result.status,'partial');assert.equal(calls,1);assert.equal(saved.result.report_type,'source_excerpts');
  assert.equal(saved.next_attempt_at,null);
  assert.deepEqual(saved.result.models_used,[]);
  assert.equal(saved.documents[0].reviewed_pages,0);
  assert.ok(saved.result.evidence.length>0);
  assert.equal((await research(db,files,{...options,model:{generate(){throw new Error('must not run');}}})).status,'idle');
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
  assert.ok(selected.some(p=>p.id==='a140'));assert.ok(selected.some(p=>p.id==='t1'));assert.ok(selected.length<=limits.pages);
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

import {before,after,beforeEach,afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {openDatabase} from '../db.js';
import {localFiles} from '../files.js';
import {initialiseApp,changeCompany} from '../app-state.js';
import {companies} from '../repository.js';
import {createResearch,researchJob} from '../research/jobs.js';
import {discoverLinks} from '../research/sources.js';
import {research} from '../research/worker.js';
import {extract} from '../extraction/worker.js';
import {digest} from '../outputs.js';
import {ModelError} from '../analysis/gemini.js';
import {SourceClient} from '../http.js';

let db,folder,files,annual,transcript;const NOW=new Date('2026-11-13T12:00:00Z');
before(async()=>{
 db=await openDatabase({memory:true,connectionString:''});
 annual=await pdf('TEST revenue was 100 INR crore for the year ended March 2026.');
 transcript=await pdf('Management expects revenue growth of 10 percent next year.');
});
async function pdf(...texts){const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica);for(const text of texts)d.addPage([500,300]).drawText(text,{x:20,y:200,font,size:12});return Buffer.from(await d.save());}
after(async()=>db.close());
beforeEach(async()=>{await db.query('TRUNCATE portfolios,companies,provider_backoff CASCADE');await initialiseApp(db,NOW);folder=await mkdtemp(join(tmpdir(),'finn-research-test-'));files=localFiles(folder);});
afterEach(async()=>rm(folder,{recursive:true,force:true}));
const docs=[{kind:'annual_report',title:'TEST Annual Report 2026',source_url:'https://nsearchives.nseindia.com/annual.pdf',discovery_url:'https://www.screener.in/company/TEST/'},
 {kind:'transcript',title:'TEST transcript November 2026',source_url:'https://nsearchives.nseindia.com/transcript.pdf',discovery_url:'https://www.screener.in/company/TEST/'}];
function mockModel({badQuote=false,failFinal=false}={}) {
 const calls=[];return {model:'gemini-3.6-flash',calls,async generate(request){calls.push(request.stage);const source=JSON.parse(request.prompt);
  if(source.pages)for(const page of source.pages)page.text=page.passages.map(p=>p.text).join('');
  if(request.stage==='page_extraction')return {model:'gemini-3.1-flash-lite',data:{pages:Object.fromEntries(source.pages.map(p=>[p.block_id,[{topic:p.text.includes('expects')?'guidance':'financial_snapshot',fact:p.text.trim(),evidence:[{block_id:p.block_id,modality:'text',quote:badQuote?'not in source':p.text.trim()}]}]])),limitations:[]}};
  if(failFinal)throw new ModelError('Provider overloaded',{status:503});
  return {model:'gemini-3.6-flash',data:{title:'TEST primary-source research',sections:source.validated_findings.length?source.validated_findings.map((f,index)=>({topic:f.topic,status:'available',findings:[{statement:f.fact,evidence_indexes:[index]}]})):[{topic:'cash_quality',status:'unavailable',findings:[]}],limitations:[]}};
 }};
}
async function prepared({includeBoth=true,annualPdf=annual,pageLimit=10}={}) {
 const job=await createResearch(db,{symbol:'TEST',question:'Summarise revenue and explicit guidance.'},NOW);
 await db.query("UPDATE research_jobs SET options=options || '{\"mode\":\"full\"}'::jsonb WHERE id=$1",[job.id]);
 const options={clock:()=>NOW,discoverSources:async()=>({documents:includeBoth?docs:docs.slice(0,1),allowedHosts:[]}),clientFactory:()=>({get:async url=>({body:url.includes('annual')?annualPdf:transcript})})};
 await research(db,files,options);await research(db,files,options);if(includeBoth)await research(db,files,options);
 await extract(db,files,{clock:()=>NOW,pageLimit});return {job,options};
}
test('source discovery accepts only raw annual reports/transcripts and verifies the company',()=>{
 const html=`<a>NSE: TEST</a><a href="https://www.testcompany.com">Website</a>
 <div><h3>Annual reports</h3><ul><li><a href="https://www.bseindia.com/a.pdf">Annual Report 2026</a><button>AI Summary</button></li></ul></div>
 <div><div><h3>Concalls</h3></div><ul><li><div>Nov 2026</div><a href="https://www.testcompany.com/transcript.pdf">Transcript</a><a href="https://news.example/a.pdf">Transcript</a><a href="https://www.bseindia.com/p.pdf">PPT</a></li></ul></div>`;
 const found=discoverLinks(html,'TEST','https://www.screener.in/company/TEST/',{transcripts:4});
 assert.equal(found.documents.length,2);assert.equal(found.documents[1].kind,'transcript');assert.deepEqual(found.allowedHosts,['testcompany.com']);
 assert.throws(()=>discoverLinks(html,'OTHER','https://www.screener.in/company/OTHER/'),/identity/);
});
test('research requests deduplicate active work and support companies outside the portfolio',async()=>{
 const a=await createResearch(db,{symbol:'TEST',question:'Business snapshot'},NOW),b=await createResearch(db,{symbol:'test.ns',question:'Business snapshot'},NOW);
 assert.equal(a.id,b.id);assert.equal((await companies(db)).length,0);
 assert.equal((await researchJob(db,a.id)).nse_symbol,'TEST');
});
test('discovered company hosts cannot resolve to private network addresses',async()=>{
 let called=false;
 const client=new SourceClient({allowedHosts:['company.example'],resolveHost:async()=>[{address:'127.0.0.1',family:4}],fetchImpl:async()=>{called=true;}});
 await assert.rejects(()=>client.get('https://company.example/report.pdf'),/private network/);assert.equal(called,false);
});
test('primary PDFs pass through real page extraction and produce cited research without monitoring alerts',async()=>{
 await changeCompany(db,'TEST',false,NOW);
 const {job,options}=await prepared(),model=mockModel();
 const initial=await researchJob(db,job.id);
 assert.deepEqual(initial.documents.map(d=>[d.total_pages,d.prepared_pages,d.reviewed_pages]),[[1,1,0],[1,1,0]]);
 const first=await research(db,files,{...options,model,batchLimit:1});assert.equal(first.status,'waiting');
 assert.deepEqual((await researchJob(db,job.id)).documents.map(d=>d.reviewed_pages),[1,0]);
 assert.equal((await research(db,files,{...options,model})).status,'completed');
 const saved=await researchJob(db,job.id);
 assert.equal(saved.status,'completed');assert.equal(saved.data_as_of.pages,2);assert.equal(saved.result.evidence.length,2);
 assert.deepEqual(saved.result.models_used,['gemini-3.1-flash-lite','gemini-3.6-flash']);
 assert.ok(model.calls.includes('final_synthesis'));
 assert.equal(Number((await db.query("SELECT count(*) AS n FROM processing_jobs WHERE job_type='analyse'")).rows[0].n),0);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM alerts')).rows[0].n),0);
 assert.equal((await digest(db,{end:new Date(+NOW+1000)})).items.length,0);
 assert.ok(saved.evidence.every(e=>e.source_url.startsWith('https://nsearchives.nseindia.com/')));
});
test('a bad quote gets a separate page review and rejected statements never become citations',async()=>{
 const {job,options}=await prepared(),model=mockModel({badQuote:true});
 const first=await research(db,files,{...options,model});
 assert.equal(first.status,'waiting');
 assert.equal((await researchJob(db,job.id)).documents[0].reviewed_pages,0);
 for(let i=0;i<4;i++)await research(db,files,{...options,model});
 const saved=await researchJob(db,job.id);
 assert.equal(saved.status,'partial');
 assert.equal(saved.result.evidence.length,0);
 assert.match(saved.result.limitations.join(' '),/finding was excluded/);
 assert.deepEqual(saved.documents.map(d=>d.reviewed_pages),[1,1]);
 assert.ok(!JSON.stringify(saved.result).includes('not in source'));
});
test('a writer outage publishes the validated and cited findings as an explicit partial report',async()=>{
 const {job,options}=await prepared(),model=mockModel({failFinal:true});
 const step=await research(db,files,{...options,model});
 const saved=await researchJob(db,job.id);
 assert.equal(step.status,'partial');assert.equal(saved.result.report_type,'source_findings');
 assert.equal(saved.evidence.length,2);assert.deepEqual(saved.documents.map(d=>d.reviewed_pages),[1,1]);
 assert.match(saved.result.limitations.join(' '),/temporarily unavailable/);
 assert.deepEqual(saved.result.models_used,['gemini-3.1-flash-lite']);
 assert.equal((await research(db,files,{...options,model})).status,'idle');
});
test('a page-reader outage retains already reviewed pages and resumes after cooldown',async()=>{
 const {job,options}=await prepared(),model=mockModel();
 await research(db,files,{...options,model,batchLimit:1});
 const step=await research(db,files,{...options,model:{generate(){throw new ModelError('Busy',{status:503});}}});
 const saved=await researchJob(db,job.id);
 assert.equal(step.status,'waiting');assert.ok(saved.next_attempt_at);
 assert.deepEqual(saved.documents.map(d=>d.reviewed_pages),[1,0]);
 const healthy=mockModel();
 assert.equal((await research(db,files,{...options,clock:()=>new Date(saved.next_attempt_at),model:healthy})).status,'completed');
 assert.deepEqual(healthy.calls,['page_extraction','final_synthesis']);
});
test('passage references copy the source text and preserve layout characters and numerical checks',async()=>{
 const {sourcePassages,validatePage}=await import('../research/schema.js');
 const long='a'.repeat(725)+'\n',text=long+'Net cash from operations was INR 100 crore.';
 const pieces=sourcePassages(text);
 assert.equal(pieces.join(''),text);
 const id='example-page',blocks=[{id,content:{text}}];
 const value={pages:{p1:[{topic:'cash_quality',fact:'Cash from operations was INR 100 crore.',evidence:[{block_id:'p1',modality:'text',quote:'',source_passages:[pieces.length]}]}]},limitations:[]};
 const checked=validatePage(value,blocks);assert.ok(text.includes(checked.findings[0].evidence[0].quote));
 assert.equal(checked.findings[0].evidence[0].block_id,id);
 value.pages.p1[0].fact='Cash was 999 crore.';assert.throws(()=>validatePage(value,blocks),/uncited number/);
 value.pages.p1[0].evidence[0].source_passages=[200];assert.throws(()=>validatePage(value,blocks),/passage reference/);
});
test('missing transcript coverage is explicit in a partial report',async()=>{
 const {job,options}=await prepared({includeBoth:false}),model=mockModel();
 assert.equal((await research(db,files,{...options,model})).status,'partial');
 const saved=await researchJob(db,job.id);
 assert.equal(saved.status,'partial');assert.match(saved.result.limitations.join(' '),/No usable transcript/);
});
test('incomplete coverage retries just the affected group as individual pages, including pages without findings',async()=>{
 const annualPdf=await pdf('Introductory page','Second page');
 const {job,options}=await prepared({annualPdf,includeBoth:false});
 const calls=[];
 const model={model:'test',async generate(request){
   if(request.stage==='final_synthesis')return {data:{title:'Research',sections:[{topic:'cash_quality',status:'unavailable',findings:[]}],limitations:[]}};
   const pages=JSON.parse(request.prompt).pages;
   calls.push(pages.map(p=>p.page));
   assert.deepEqual(request.responseSchema.properties.pages.required,pages.map(p=>p.block_id));
   assert.deepEqual(request.images.map(i=>i.blockId),pages.map(p=>p.block_id));
   return {data:{pages:{p1:[]},limitations:[]}};
 }};
 const interrupted=await research(db,files,{...options,model});
 assert.equal(interrupted.status,'waiting');assert.match(interrupted.error,/exactly the supplied pages/);
 assert.equal((await researchJob(db,job.id)).documents[0].reviewed_pages,0);
 assert.equal((await research(db,files,{...options,model,batchLimit:1})).status,'waiting');
 assert.equal((await researchJob(db,job.id)).documents[0].reviewed_pages,1);
 assert.equal((await research(db,files,{...options,model})).status,'partial');
 assert.deepEqual(calls,[[1,2],[1],[2]]);
 assert.equal((await researchJob(db,job.id)).documents[0].reviewed_pages,2);
});
test('the upgraded worker resumes an exhausted legacy job and reuses overlapping cross-document checkpoints',async()=>{
 const {job,options}=await prepared({annualPdf:await pdf('Annual page one','Annual page two','Annual page three')});
 const blocks=(await db.query(`SELECT b.id,rd.kind FROM content_blocks b JOIN assets a ON a.id=b.asset_id
   JOIN research_documents rd ON rd.disclosure_id=a.disclosure_id WHERE rd.research_job_id=$1 ORDER BY rd.kind,b.sequence`,[job.id])).rows;
 for(const [key,ids] of [['a',[blocks[0].id,blocks[3].id]],['b',[blocks[1].id,blocks[3].id]]]){
   await db.query("INSERT INTO research_batches VALUES ($1,$2,'old-model',$3,$4)",[job.id,key,JSON.stringify({covered_block_ids:ids,findings:[],limitations:[]}),NOW]);
 }
 await db.query("UPDATE research_jobs SET status='failed',attempts=5,error_kind='processing',error='Research page coverage mismatch' WHERE id=$1",[job.id]);
 const schema=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
 // Execute the idempotent startup migrations as openDatabase does for a pre-existing catalogue.
 for(const sql of schema.slice(schema.indexOf('-- Older workers'),schema.indexOf('CREATE TABLE IF NOT EXISTS research_documents')).split(';').filter(s=>s.trim()))await db.query(sql);
 const saved=await researchJob(db,job.id);
 assert.equal(saved.status,'waiting');assert.deepEqual(saved.documents.map(d=>d.reviewed_pages),[2,1]);
 const healthy=mockModel(),seen=[];
 const model={model:healthy.model,generate(request){if(request.stage==='page_extraction')seen.push(...JSON.parse(request.prompt).pages.map(p=>p.page));return healthy.generate(request);}};
 assert.equal((await research(db,files,{...options,model})).status,'completed');
 assert.deepEqual(seen,[3]);
 const result=await researchJob(db,job.id);
 assert.deepEqual(result.documents.map(d=>d.reviewed_pages),[3,1]);assert.ok(result.result.models_used.includes('old-model'));
});
test('an expired/replaced research owner cannot save discovered sources',async()=>{
 const job=await createResearch(db,{symbol:'TEST',question:'Business snapshot'},NOW);
 const result=await research(db,files,{clock:()=>NOW,discoverSources:async()=>{
   await db.query("UPDATE research_jobs SET lease_token='00000000-0000-4000-8000-000000000099' WHERE id=$1",[job.id]);
   return {documents:docs,allowedHosts:[]};
 }});
 assert.equal(result.status,'lease_lost');
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM research_documents')).rows[0].n),0);
 assert.equal((await researchJob(db,job.id)).status,'running');
});

import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {openDatabase} from '../db.js';
import {localFiles} from '../files.js';
import {initialiseApp} from '../app-state.js';
import {createResearch,researchJob} from '../research/jobs.js';
import {research} from '../research/worker.js';
import {discoverLinks,exchangeSources,primaryUrl,sourceKind} from '../research/sources.js';
import {initialSources,additionalSources} from '../research/selection.js';
import {uniquePassages} from '../research/adaptive.js';
import {limits} from '../research/brief.js';
import {ModelError} from '../analysis/gemini.js';

let db,folder,files;
before(async()=>{db=await openDatabase({memory:true,connectionString:''});});
after(async()=>db.close());
beforeEach(async()=>{await db.query('TRUNCATE portfolios,companies,provider_backoff CASCADE');await initialiseApp(db);folder=await mkdtemp(join(tmpdir(),'finn-source-test-'));files=localFiles(folder);});
afterEach(async()=>rm(folder,{recursive:true,force:true}));
const source=(kind,label,metadata={})=>({id:label,kind,title:label,source_url:`https://www.bseindia.com/${label}.pdf`,discovery_url:'https://www.screener.in/company/TEST/',metadata});
async function pdf(text){const d=await PDFDocument.create(),font=await d.embedFont(StandardFonts.Helvetica);d.addPage([500,600]).drawText(text,{font,x:10,y:550,size:10,maxWidth:480});return Buffer.from(await d.save());}

test('catalogue discovers all periods, official results resolvers, presentations and filings without secondary summaries',()=>{
 const html=`<div data-company-id="77"></div><a>NSE: TEST</a><a href="https://company.example">Website</a>
 <div><h3>Annual reports</h3><ul>${Array.from({length:8},(_,i)=>`<li><a href="https://www.bseindia.com/a${i}.pdf">Annual Report ${2026-i}</a></li>`).join('')}</ul></div>
 <div><h3>Concalls</h3><ul><li><div>Nov 2026</div><a href="https://company.example/call.pdf">Transcript</a><a href="https://company.example/deck.pdf">PPT</a><a href="https://broker.example/report.pdf">Transcript</a><button>AI Summary</button></li></ul></div>
 <div><h3>Announcements</h3><ul><li><a href="https://www.bseindia.com/change.pdf">Change in Management<div><time datetime="2026-11-14T10:00:00+05:30"></time>AI generated summary that must not enter evidence</div></a></li><li><a href="https://www.bseindia.com/rating.pdf">Credit Rating</a></li></ul></div>
 <a href="/company/source/quarter/77/9/2026/" aria-label="Raw PDF"></a><a href="/company/source/quarter/88/9/2026/"></a>`;
 const found=discoverLinks(html,'TEST','https://www.screener.in/company/TEST/');
 assert.equal(found.catalogue.length,12);assert.equal(found.catalogue.filter(d=>d.kind==='annual_report').length,8);
 const result=found.catalogue.find(d=>d.kind==='quarterly_result');assert.equal(result.metadata.period_end,'2026-09-30');assert.equal(result.metadata.published_at,null);
 assert.ok(!JSON.stringify(found.catalogue).includes('AI generated'));assert.ok(!JSON.stringify(found.catalogue).includes('broker.example'));
 const core=discoverLinks(html,'TEST','https://www.screener.in/company/TEST/',{source_policy:'assignment'});
 assert.ok(core.catalogue.every(d=>['annual_report','transcript'].includes(d.kind)));assert.equal(core.catalogue.length,9);
 assert.throws(()=>primaryUrl('https://www.screener.in/register/','https://www.screener.in'),/issuer or exchange/);
});

test('selection favours recent foundations and uses comparative evidence before earlier annual reports',()=>{
 const catalogue=[source('annual_report','older',{report_year:2025,sort_date:'2025-01-01'}),source('annual_report','current',{report_year:2026,sort_date:'2026-01-01'}),source('transcript','call',{call_month:'2026-11-01',sort_date:'2026-11-01'}),source('quarterly_result','result',{period_end:'2026-09-30',sort_date:'2026-09-30'}),source('ownership','pledges')];
 const chosen=initialSources(catalogue);assert.deepEqual(chosen.map(d=>d.title),['current','call','result']);
 assert.equal(initialSources(catalogue,'assignment').length,2);
 const documents=chosen.map(d=>({...d,status:'downloaded'})),gaps=[{topic:'cash_quality',question:'What is the cash flow trend?'}];
 assert.equal(additionalSources(catalogue,documents,{gaps,question:'Cash quality'}).find(d=>d.kind==='annual_report').title,'older');
 const pages=[{text:'Consolidated financial highlights and cash flow: revenue 100 2024, 110 2025 and 120 2026.'}];
 assert.equal(additionalSources(catalogue,documents,{gaps,question:'Cash quality',pages}).length,0);
 assert.equal(additionalSources(catalogue,documents,{gaps:[{topic:'balance_sheet',question:'Are promoter shares pledged?'}],question:'Ownership'}).find(d=>d.kind==='ownership').title,'pledges');
 assert.ok(!additionalSources(catalogue,documents,{gaps,question:'Cash quality'}).some(d=>d.kind==='ownership'));
});

test('four-quarter requests select missing reported periods and earlier calls, respecting assignment-only sources',()=>{
 const catalogue=[...['2026-09-30','2026-06-30','2026-03-31','2025-12-31','2025-09-30'].map(p=>source('quarterly_result','result-'+p,{period_end:p,sort_date:p})),...['2026-11-01','2026-08-01','2026-05-01','2026-02-01','2025-11-01'].map(p=>source('transcript','call-'+p,{call_month:p,sort_date:p}))];
 const documents=[{...catalogue[0],status:'downloaded'}];
 const planned=additionalSources(catalogue,documents,{question:'Compare the last four quarters against management guidance'});
 assert.equal(planned.filter(d=>d.kind==='quarterly_result').length,3);assert.ok(!planned.some(d=>d.title==='result-2025-09-30'));
 assert.ok(planned.some(d=>d.kind==='transcript'));
 assert.ok(additionalSources(catalogue,documents,{question:'Compare the last four quarters',policy:'assignment'}).every(d=>d.kind==='transcript'));
});

test('NSE attachments carry explicit period and publication metadata while third-party ratings stay excluded',()=>{
 const rows=[{title:'Outcome of Board Meeting',publishedAt:'2026-10-28T09:00:00Z',rawMetadata:{attchmntText:'Financial results for the period ended September 30, 2026.'},assets:[{sourceUrl:'https://nsearchives.nseindia.in/results.pdf'}]}];
 const [doc]=exchangeSources(rows,'https://www.nseindia.com/');assert.equal(doc.kind,'quarterly_result');assert.equal(doc.metadata.period_end,'2026-09-30');assert.equal(doc.metadata.published_at,new Date(rows[0].publishedAt).toISOString());
 const reused=exchangeSources([{...rows[0],publishedAt:new Date(rows[0].publishedAt)}],'https://www.nseindia.com/');
 assert.equal(initialSources(reused)[0].metadata.published_at,new Date(rows[0].publishedAt).toISOString());
 assert.equal(sourceKind('Credit Rating rationale'),null);assert.equal(sourceKind('Investor presentation'), 'presentation');
});

test('duplicate dated evidence is sent once while different periods and scopes remain distinct',()=>{
 const p=(id,text,metadata={})=>({id,text,document:{id,metadata}});
 const text='Operating cash flow in FY2026 was INR 100 crore. '.repeat(3);
 assert.equal(uniquePassages([p('a',text,{scope:'consolidated'}),p('b',text,{scope:'consolidated'})]).length,1);
 assert.equal(uniquePassages([p('a',text),p('b',text)]).length,2);
 assert.equal(uniquePassages([p('a',text,{scope:'standalone'}),p('b',text,{scope:'consolidated'})]).length,2);
 const undated='The company recorded revenue of 100 and operating profit of 20 in the reporting period. '.repeat(2);
 assert.equal(uniquePassages([p('a',undated,{period_label:'2025'}),p('b',undated,{period_label:'2026'})]).length,2);
 assert.equal(uniquePassages([p('scan','')]).length,1);
});

for(const mode of ['success','quota'])test('dynamic source expansion preserves the initial brief: '+mode,async()=>{
 const catalogue=[source('annual_report','annual-new',{report_year:2026,sort_date:'2026-01-01'}),source('annual_report','annual-old',{report_year:2025,sort_date:'2025-01-01'}),source('transcript','call',{call_month:'2026-11-01',sort_date:'2026-11-01'}),source('quarterly_result','result',{period_end:'2026-09-30',sort_date:'2026-09-30'}),source('ownership','unused-pledges')].map(({id,...d})=>d);
 const ordinary='The company manufactures industrial equipment and sells products through its dealer network. It describes its business and product portfolio.';
 const cash='Consolidated statement of cash flows. Operating cash flow was INR 100 crore in FY2025-26. Profit after tax was INR 90 crore. Purchases of property plant equipment were INR 20 crore. Receivables and payables changed working capital.';
 const bodies={};for(const doc of catalogue)bodies[doc.source_url]=await pdf(doc.title==='annual-old'?cash:ordinary);
 const job=await createResearch(db,{symbol:'TEST'}),downloads=[],requests=[];
 const options={budgetMs:120000,discoverSources:async()=>({catalogue,allowedHosts:[],warnings:[]}),clientFactory:()=>({async get(url){
   downloads.push(url);
   if(url.includes('annual-old')){const saved=await researchJob(db,job.id);assert.ok(saved.result);assert.equal(saved.status,'running');}
   assert.ok(!url.includes('unused-pledges'));return {body:bodies[url],url};
 }})};
 await research(db,files,options);
 let saved=await researchJob(db,job.id);assert.equal(saved.sources.length,5);assert.equal(saved.documents.length,3);assert.equal(downloads.length,0);
 for(let i=0;i<3;i++)await research(db,files,options);
 const model={model:'mock',async generate(request){
   requests.push(request);const input=JSON.parse(request.prompt),expanding=request.stage==='research_expansion';
   if(expanding&&mode==='quota'&&requests.length===2)throw new ModelError('Daily quota exceeded',{status:429,retryAfterMs:3600000});
   assert.ok(input.evidence.reduce((n,p)=>n+p.passages.reduce((m,s)=>m+s.text.length,0),0)<=limits.characters);
   const page=expanding?input.evidence.find(p=>p.passages.some(s=>s.text.includes('Operating cash flow'))):input.evidence[0];assert.ok(page);
   return {data:{title:'Company overview',sections:[{topic:expanding?'cash_quality':'business_snapshot',findings:[{statement:expanding?'Operating cash flow was INR 100 crore in FY2025-26.':'The company manufactures industrial equipment.',citations:[{source_id:page.passages[0].id,quote:''}]}]}],limitations:[],gaps:expanding?[]:[{topic:'cash_quality',question:'Find operating cash flow and profit after tax in the cash flow statement.'}]}};
 }};
 assert.equal((await research(db,files,{...options,model})).status,mode==='quota'?'failed':'completed');
 if(mode==='quota'){
   const paused=await researchJob(db,job.id);assert.ok(paused.result);assert.equal(paused.error_kind,'quota_limit');assert.equal(paused.next_attempt_at,null);
   assert.equal((await research(db,files,{...options,model})).status,'idle');
   await db.query("UPDATE research_jobs SET status='queued',error_kind=NULL,research_state=research_state - 'brief_started_at' - 'calls' WHERE id=$1",[job.id]);
   assert.equal((await research(db,files,{...options,model})).status,'completed');
 }
 saved=await researchJob(db,job.id);assert.equal(requests.length,mode==='quota'?3:2);
 assert.equal(requests.filter(r=>r.stage==='research_brief').length,1);assert.equal(saved.documents.length,4);assert.equal(saved.sources.filter(s=>!s.download_status).length,1);
 assert.ok(saved.result.sections.some(s=>s.topic==='cash_quality'));assert.ok(saved.evidence.some(e=>e.source_url.includes('annual-old')));
 assert.ok(saved.documents.find(d=>d.title==='annual-old').metadata.selection_reason);assert.equal(saved.result.source_selection.selected_documents,4);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM alerts')).rows[0].n),0);
});

test('missing historical quarters resolve to direct exchange attachments instead of login-gated links',async()=>{
 const periods=['2026-09-30','2026-06-30','2026-03-31','2025-12-31'];
 const catalogue=[source('annual_report','annual',{report_year:2026,sort_date:'2026-01-01'}),source('transcript','call',{call_month:'2026-11-01',sort_date:'2026-11-01'}),...periods.map((period,i)=>({...source('quarterly_result','quarter-'+period,{period_end:period,sort_date:period,resolver:i>0}),...(i?{source_url:`https://www.screener.in/company/source/quarter/77/${Number(period.slice(5,7))}/${period.slice(0,4)}/`}:{})}))].map(({id,...d})=>d);
 const body=await pdf('The company manufactures equipment. Quarterly revenue was INR 100 crore and profit after tax was INR 20 crore for this reporting period. Management describes operating performance.');
 const job=await createResearch(db,{symbol:'TEST',question:'Compare the last four quarters against management guidance.'}),lookups=[],downloads=[];
 const options={budgetMs:120000,discoverSources:async()=>({catalogue,allowedHosts:[],warnings:[]}),clientFactory:()=>({get:async url=>{
   assert.ok(!url.includes('screener.in'));downloads.push(url);return {body,url};
 }}),fetchExchange:async(_client,name,start)=>{
   assert.equal(name,'TEST');assert.ok((await researchJob(db,job.id)).result);
   const period=new Date(+start+19800000).toISOString().slice(0,10);lookups.push(period);
   const label=new Date(period+'T00:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'});
   return [{title:'Financial results',publishedAt:new Date(+start+30*86400000).toISOString(),rawMetadata:{attchmntText:'Financial results for the period ended '+label+'.'},assets:[{sourceUrl:`https://nsearchives.nseindia.in/${period}.pdf`}]}];
 }};
 await research(db,files,options);for(let i=0;i<3;i++)await research(db,files,options);
 let calls=0;
 const model={model:'mock',async generate(request){calls++;const input=JSON.parse(request.prompt),page=input.evidence[0];
   return {data:{title:'Quarterly evidence',sections:[{topic:'financial_snapshot',findings:[{statement:calls===1?'The company manufactures equipment.':'Quarterly revenue was INR 100 crore.',citations:[{source_id:page.passages[0].id,quote:''}]}]}],limitations:[],gaps:calls===1?[{topic:'financial_snapshot',question:'Find reported quarterly revenue outcomes for the last four quarters.'}]:[]}};
 }};
 assert.equal((await research(db,files,{...options,model})).status,'completed');
 const saved=await researchJob(db,job.id);
 assert.deepEqual(lookups,periods.slice(1));assert.equal(saved.documents.length,6);assert.equal(calls,2);
 assert.equal(downloads.filter(url=>url.includes('nseindia.in')).length,3);assert.equal(saved.sources.length,9);
});

test('useful new gaps can grow research across three passes while preserving the shared model-call budget',async()=>{
 const catalogue=[source('annual_report','current',{report_year:2026,sort_date:'2026-01-01'}),source('annual_report','prior',{report_year:2025,sort_date:'2025-01-01'}),source('transcript','latest-call',{call_month:'2026-11-01',sort_date:'2026-11-01'}),source('offer_document','offer',{sort_date:'2025-08-01'})].map(({id,...d})=>d);
 const texts={current:'The company manufactures industrial equipment and describes its product portfolio and distribution network. Its customers operate across industries.',prior:'Cobalt operating cash flow was INR 100 crore in FY2026. Consolidated cash flow statements describe operating activities and financing cash movements for the reporting year.','latest-call':'The company manufactures industrial equipment and discusses the product portfolio and distribution network. Management describes its operating business.','offer':'The IPO quartz project received proceeds of INR 10 crore in FY2026. The prospectus describes quartz project funding and the use of proceeds for the project.'};
 const bodies={};for(const doc of catalogue)bodies[doc.source_url]=await pdf(texts[doc.title]);
 const job=await createResearch(db,{symbol:'TEST',question:'Explain the business and investigate important evidence gaps.'});
 const options={budgetMs:120000,discoverSources:async()=>({catalogue,allowedHosts:[]}),clientFactory:()=>({get:async url=>({body:bodies[url],url})})};
 await research(db,files,options);await research(db,files,options);await research(db,files,options);
 let calls=0;
 const model={model:'mock',async generate(request){
   calls++;const input=JSON.parse(request.prompt),term=calls===2?'Cobalt':calls===3?'quartz':'manufactures';
   const page=input.evidence.find(p=>p.passages.some(s=>s.text.includes(term)));assert.ok(page);
   const passage=page.passages.find(s=>s.text.includes(term));
   return {data:{title:'Growing overview',sections:[{topic:calls===1?'business_snapshot':calls===2?'cash_quality':'capital_allocation',findings:[{statement:calls===1?'The company manufactures industrial equipment.':calls===2?'Cobalt operating cash flow was INR 100 crore in FY2026.':'The IPO quartz project received proceeds of INR 10 crore in FY2026.',citations:[{source_id:passage.id,quote:''}]}]}],limitations:[],gaps:[{topic:calls===1?'cash_quality':calls===2?'capital_allocation':'balance_sheet',question:calls===1?'Find cobalt operating cash flow in the cash statement.':calls===2?'Find IPO quartz project funding and the use of proceeds in the prospectus.':'Find additional debt maturity and liquidity details.'}]}};
 }};
 assert.equal((await research(db,files,{...options,model})).status,'completed');
 const saved=await researchJob(db,job.id);assert.equal(calls,3,JSON.stringify({adaptive:saved.result.adaptive,note:saved.result.processing_note,documents:saved.documents.map(d=>d.title)}));assert.equal(saved.research_state.calls,limits.attempts);
 assert.equal(saved.result.adaptive.passes,3);assert.equal(saved.result.adaptive.stop_reason,'budget_reached');assert.equal(saved.result.adaptive.added_findings,2);
 assert.equal(saved.documents.length,4);assert.equal(saved.result.sections.length,3);
});

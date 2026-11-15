import {test} from 'node:test';import assert from 'node:assert/strict';
import {hostedResearchTrigger,runHostedResearch} from '../research/hosted.js';
import {createResearchWorkerHandler} from '../../api/research.js';
test('hosted research registers post-response work, coalesces triggers and ignores quota-paused jobs',async()=>{
 const callbacks=[];let calls=0,resolve;const gate=new Promise(r=>resolve=r);
 const kick=hostedResearchTrigger({enabled:true,afterResponse:p=>callbacks.push(p),work:async()=>{calls++;await gate;}});
 assert.equal(kick({status:'failed',error_kind:'quota_limit'}),false);
 assert.equal(kick({status:'waiting',next_attempt_at:new Date(Date.now()+60000)}),false);
 assert.equal(kick({status:'queued'}),true);assert.equal(kick({status:'queued'}),false);
 await Promise.resolve();assert.equal(calls,1);resolve();await Promise.all(callbacks);
 assert.equal(kick({status:'queued'}),true);await Promise.all(callbacks);assert.equal(calls,2);
});
test('hosted worker advances source checkpoints and always closes its independent connection',async()=>{
 let calls=0,closed=0;const states=['waiting','waiting','completed'];
 const result=await runHostedResearch({openDb:async()=>({close:async()=>closed++}),files:async()=>({}),run:async()=>({status:states[calls++]}),budgetMs:10000});
 assert.equal(result.status,'completed');assert.equal(calls,3);assert.equal(closed,1);
 calls=0;await runHostedResearch({openDb:async()=>({close:async()=>closed++}),files:async()=>({}),run:async()=>{calls++;return {status:'failed',error:'Quota limit'};},budgetMs:10000});assert.equal(calls,1);
});
test('dedicated hosted endpoint rejects unauthorised callers before touching workers',async()=>{
 let calls=0;const handler=createResearchWorkerHandler({authorise:req=>req.headers.authorization==='Bearer test',run:async()=>{calls++;return {status:'idle'};}});
 const request=async headers=>{const res={setHeader(){},status(s){this.code=s;return this;},json(v){this.body=v;return this;}};await handler({method:'POST',headers},res);return res;};
 assert.equal((await request({})).code,401);assert.equal(calls,0);assert.equal((await request({authorization:'Bearer test'})).body.status,'idle');assert.equal(calls,1);
});

test('API creation, eligible polling and manual retry register hosted work; quota-paused polling does not',async()=>{
 const {openDatabase}=await import('../db.js'),{createAppHandler}=await import('../app-api.js');
 const db=await openDatabase({memory:true,connectionString:''}),callbacks=[];let work=0,cookie;
 const trigger=hostedResearchTrigger({enabled:true,afterResponse:p=>callbacks.push(p),work:async()=>{work++;}});
 const handler=createAppHandler({db,accessCode:'isolated-hosted-test',triggerResearch:trigger});
 const request=async(resource,method='GET',body,query={})=>{
  const res={setHeader(k,v){if(k==='Set-Cookie')cookie=v.split(';')[0];},status(code){this.code=code;return this;},json(v){this.body=v;return this;}};
  await handler({method,body,query:{resource,...query},headers:{host:'localhost','x-finn-client':'web',...(cookie?{cookie}:{})},socket:{}},res);await Promise.all(callbacks);return res;
 };
 try{
  await request('session','POST',{access_code:'isolated-hosted-test'});
  const created=await request('research','POST',{symbol:'TEST'});assert.equal(created.code,202);assert.equal(work,1);
  await request('research','GET',undefined,{id:created.body.id});assert.equal(work,2);
  await db.query("UPDATE research_jobs SET status='failed',error_kind='quota_limit' WHERE id=$1",[created.body.id]);
  await request('research','GET',undefined,{id:created.body.id});assert.equal(work,2);
  await request('research-retry','POST',{id:created.body.id});assert.equal(work,3);
 }finally{await db.close();}
});

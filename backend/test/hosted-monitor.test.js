import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../db.js';
import {PORTFOLIO} from '../repository.js';
import {hostedMonitoringTrigger,runHostedMonitoring} from '../hosted-monitor.js';
import {createAppHandler} from '../app-api.js';

test('hosted monitoring coalesces simultaneous polls, throttles turns, honours pause and active leases',async()=>{
 const db=await openDatabase({memory:true,connectionString:''}),callbacks=[];let now=new Date(),calls=0;
 const kick=hostedMonitoringTrigger({enabled:true,clock:()=>now,afterResponse:p=>callbacks.push(p),work:async()=>calls++});
 try{
  assert.equal((await Promise.all(Array.from({length:8},()=>kick(db)))).filter(Boolean).length,1);
  await Promise.all(callbacks);assert.equal(calls,1);assert.equal(await kick(db),false);
  now=new Date(+now+16000);
  await db.query('UPDATE portfolio_settings SET monitoring_enabled=false');assert.equal(await kick(db),false);
  await db.query('UPDATE monitoring_state SET refresh_requested_at=$1,lease_expires_at=$2',[now,new Date(+now+60000)]);
  assert.equal(await kick(db),false);
  await db.query('UPDATE monitoring_state SET lease_expires_at=NULL');assert.equal(await kick(db),true);
  await Promise.all(callbacks);assert.equal(calls,2);
  now=new Date(+now+16000);await db.query('UPDATE monitoring_state SET last_started_at=$1',[now]);assert.equal(await kick(db),false);
 }finally{await db.close();}
});

test('hosted monitoring uses its own connection, records setup failure and always closes',async()=>{
 let closed=0,calls=0;const queries=[],db={query:async(...args)=>queries.push(args),close:async()=>closed++};
 const result=await runHostedMonitoring({openDb:async()=>db,files:async()=>({backend:'test'}),run:async(actual,files,options)=>{
  assert.equal(actual,db);assert.equal(files.backend,'test');assert.equal(options.budgetMs,45000);calls++;return {status:'ok'};
 }});assert.equal(result.status,'ok');assert.equal(closed,1);assert.equal(calls,1);
 await assert.rejects(runHostedMonitoring({openDb:async()=>db,files:async()=>{throw Error('Missing file storage configuration');}}),/Missing file storage/);
 assert.equal(closed,2);assert.equal(queries[0][1][0],PORTFOLIO);assert.match(queries[0][1][1],/Missing file storage/);
});

test('authenticated portfolio polling, refresh and membership changes trigger hosted monitoring',async()=>{
 const db=await openDatabase({memory:true,connectionString:''});let kicks=0,cookie;
 const handler=createAppHandler({db,accessCode:'isolated-test-code',triggerMonitoring:async actual=>{assert.equal(actual,db);kicks++;}});
 const request=async(resource,method='GET',body)=>{
  const res={setHeader(k,v){if(k==='Set-Cookie')cookie=v.split(';')[0];},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
  await handler({method,body,query:{resource},headers:{host:'localhost','x-finn-client':'web',...(cookie?{cookie}:{})},socket:{}},res);return res;
 };
 try{
  assert.equal((await request('portfolio')).code,401);assert.equal(kicks,0);
  await request('session','POST',{access_code:'isolated-test-code'});
  for(const [resource,method,body] of [['portfolio','GET'],['portfolio','POST',{symbol:'TCS'}],['refresh','POST'],['status','GET']])assert.equal((await request(resource,method,body)).code,200);
  assert.equal(kicks,4);
 }finally{await db.close();}
});

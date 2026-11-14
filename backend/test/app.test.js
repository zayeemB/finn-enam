import {before,after,beforeEach,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../db.js';
import {PORTFOLIO,companies} from '../repository.js';
import {initialiseApp,changeCompany,settings} from '../app-state.js';
import {createAppHandler} from '../app-api.js';
import {runTick,saveDueDigest,publishNotifications} from '../monitor.js';
import {startServer} from '../server.js';

let db;const NOW=new Date('2026-11-13T12:00:00Z'),code='test-demo-access-code';
before(async()=>{db=await openDatabase({memory:true,connectionString:''});});
after(async()=>db.close());
beforeEach(async()=>{await db.query('TRUNCATE portfolios,companies,provider_backoff,app_sessions CASCADE');await initialiseApp(db,NOW);});
function client(clock=()=>NOW) {
  const handler=createAppHandler({db,accessCode:code,clock});let cookie;
  return async(resource,method='GET',body,extra={})=>{
    const headers={host:'127.0.0.1:3001','x-finn-client':'web',...(cookie?{cookie}:{}),...extra};
    const response={headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(v){this.body=v;return this;},send(v){this.body=v;return this;}};
    await handler({method,headers,body,query:{resource},socket:{remoteAddress:'127.0.0.1'}},response);
    if(response.headers['Set-Cookie'])cookie=response.headers['Set-Cookie'].split(';')[0];
    return response;
  };
}
test('browser sessions hide worker credentials, expire and revoke on logout',async()=>{
  let now=NOW;const request=client(()=>now);
  assert.equal((await request('portfolio')).code,401);
  const login=await request('session','POST',{access_code:code});
  assert.equal(login.code,200);assert.match(login.headers['Set-Cookie'],/HttpOnly; SameSite=Strict/);
  assert.deepEqual(login.body,{authenticated:true});
  assert.equal((await request('portfolio')).code,200);
  await request('session','DELETE');assert.equal((await request('portfolio')).code,401);
  await request('session','POST',{access_code:code});now=new Date(+NOW+13*3600000);
  assert.equal((await request('portfolio')).code,401);
});
test('cross-site mutations and repeated wrong logins are rejected',async()=>{
  const request=client();
  assert.equal((await request('session','POST',{access_code:code},{origin:'https://evil.example'})).code,403);
  assert.equal((await request('session','POST',{access_code:code},{'x-finn-client':undefined})).code,403);
  for(let i=0;i<5;i++)assert.equal((await request('session','POST',{access_code:'wrong'})).code,401);
  assert.equal((await request('session','POST',{access_code:code})).code,429);
});
test('company controls add and remove membership without replacing the rest of the portfolio',async()=>{
  const request=client();await request('session','POST',{access_code:code});
  await request('portfolio','POST',{symbol:'tcs.ns'});await request('portfolio','POST',{symbol:'RELIANCE'});
  await request('portfolio','POST',{symbol:'TCS'});
  assert.equal((await request('portfolio')).body.length,2);
  await request('portfolio','DELETE',{symbol:'TCS'});
  assert.deepEqual((await companies(db)).map(c=>c.nse_symbol),['RELIANCE']);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM companies')).rows[0].n),2);
  assert.equal((await request('portfolio','POST',{symbol:'bad/ticker'})).code,400);
});
test('watchlist prices use current completed sessions and do not attach volume from another date',async()=>{
  await changeCompany(db,'TCS',false,NOW);const company=(await companies(db))[0];
  for(const [metric,value,day] of [['close',100,'2026-11-11'],['close',110,'2026-11-12'],['volume',9000,'2026-11-11']]) {
    await db.query(`INSERT INTO observations(id,company_id,metric,value,unit,period_start,period_end,frequency,scope,source_url,evidence_snapshot,collected_at)
      VALUES ($1,$2,$3,$4,$5,$6,$6,'daily','market','https://query2.finance.yahoo.com/test','{}',$7)`,
    [randomUUID(),company.id,metric,value,metric==='close'?'INR/share':'shares',day,NOW]);
  }
  const request=client();await request('session','POST',{access_code:code});
  const row=(await request('portfolio')).body[0];
  assert.equal(row.market.close,110);assert.equal(row.market.previous_close,100);
  assert.ok(Math.abs(row.market.change_percent-10)<1e-8);assert.equal(row.market.volume,null);
});
test('settings persist all thresholds and reject invalid patches atomically',async()=>{
  const request=client();await request('session','POST',{access_code:code});
  const updated=await request('settings','PATCH',{digest_hours:36,monitoring_minutes:5,price_percent:4,volume_multiple:3,volume_sessions:10,announcement_categories:['results'],price_enabled:false});
  assert.equal(updated.code,200);assert.equal(updated.body.digest_hours,36);
  assert.equal(updated.body.rules.find(r=>r.rule_type==='price_move').enabled,false);
  assert.equal((await request('settings','PATCH',{digest_hours:12,announcement_categories:['made_up']})).code,400);
  assert.equal((await settings(db)).digest_hours,36);
});
test('digest windows persist once, notifications deduplicate, and read acknowledgements are saved',async()=>{
  await db.query('UPDATE portfolio_settings SET digest_hours=1,digest_anchor_at=$1',[new Date(+NOW-2*3600000)]);
  await saveDueDigest(db,NOW);await saveDueDigest(db,NOW);await saveDueDigest(db,NOW);
  await publishNotifications(db,NOW);await publishNotifications(db,NOW);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM digest_runs')).rows[0].n),2);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM notifications')).rows[0].n),2);
  const request=client();await request('session','POST',{access_code:code});
  const notification=(await request('notifications')).body[0];
  assert.equal((await request('notifications','PATCH',{id:notification.id})).body.read_at.toISOString(),NOW.toISOString());
});
test('the automatic tick has one owner and HTTP reads can continue during worker network waits',async()=>{
  await changeCompany(db,'TCS',false,NOW);
  let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
  const first=runTick(db,{}, {clock:()=>NOW,services:{collect:async()=>{enter();await hold;return {status:'ok'};}}});
  await entered;
  assert.equal((await runTick(db,{}, {clock:()=>NOW})).status,'busy');
  const request=client();await request('session','POST',{access_code:code});assert.equal((await request('status')).code,200);
  release();assert.equal((await first).status,'ok');
});
test('a collection cycle covers larger portfolios across batches before advancing its interval',async()=>{
  for(let i=0;i<12;i++)await changeCompany(db,`TEST${String(i).padStart(2,'0')}`,false,NOW);
  let count=0;
  const services={collect:async()=>{
    const batch=(await companies(db)).slice(0,5);count+=batch.length;
    for(const c of batch)await db.query(`INSERT INTO collection_state(company_id,source,last_attempt_at) VALUES ($1,'nse',$2)
      ON CONFLICT(company_id,source) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`,[c.id,NOW]);
    return {status:'ok'};
  },extract:async()=>({}),analyse:async()=>({}),research:async()=>({})};
  await runTick(db,{}, {clock:()=>NOW,services});
  assert.equal((await db.query('SELECT last_collection_at FROM monitoring_state')).rows[0].last_collection_at,null);
  for(let i=0;i<10;i++)await runTick(db,{}, {clock:()=>NOW,services});
  assert.equal(count,15); // 5+5+5 attempts; final batch revisits 3 after covering the remaining 2.
  assert.equal((await db.query('SELECT last_collection_at FROM monitoring_state')).rows[0].last_collection_at.toISOString(),NOW.toISOString());
});
test('paused monitoring respects user control while manual refresh can still collect',async()=>{
  await changeCompany(db,'TCS',false,NOW);
  await db.query('UPDATE monitoring_state SET refresh_requested_at=NULL');
  await db.query('UPDATE portfolio_settings SET monitoring_enabled=false');
  let calls=0;const services={collect:async()=>{calls++;return {};}};
  await runTick(db,{}, {clock:()=>NOW,services});assert.equal(calls,0);
  await db.query('UPDATE monitoring_state SET phase=0,refresh_requested_at=$1',[NOW]);
  await runTick(db,{}, {clock:()=>NOW,services});assert.equal(calls,1);
});
test('explicit research retry requeues unavailable downloads without discarding successful evidence',async()=>{
  const request=client();await request('session','POST',{access_code:code});
  const created=await request('research','POST',{symbol:'TEST',question:'Business snapshot'});
  assert.equal(created.code,202);
  await db.query("UPDATE research_jobs SET status='failed',error_kind='configuration' WHERE id=$1",[created.body.id]);
  await db.query(`INSERT INTO research_documents(id,research_job_id,kind,title,source_url,discovery_url,status,error)
    VALUES ($1,$2,'annual_report','Report','https://nsearchives.nseindia.com/a.pdf','https://www.screener.in/company/TEST/','failed','HTTP 503')`,[randomUUID(),created.body.id]);
  assert.equal((await request('research-retry','POST',{id:created.body.id})).body.status,'queued');
  assert.equal((await db.query('SELECT status FROM research_documents')).rows[0].status,'pending');
  assert.equal((await db.query('SELECT error_kind FROM research_jobs')).rows[0].error_kind,null);
});
test('unrelated writes cannot enter or be rolled back with another request transaction',async()=>{
  let enter,release;const entered=new Promise(r=>enter=r),hold=new Promise(r=>release=r);
  const inside=randomUUID(),outside=randomUUID();
  const first=db.transaction(async tx=>{await tx.query('INSERT INTO companies(id,nse_symbol,name) VALUES ($1,$2,$2)',[inside,'INSIDE']);enter();await hold;throw new Error('rollback');});
  await entered;const second=db.query('INSERT INTO companies(id,nse_symbol,name) VALUES ($1,$2,$2)',[outside,'OUTSIDE']);
  release();await assert.rejects(first,/rollback/);await second;
  assert.deepEqual((await db.query('SELECT nse_symbol FROM companies')).rows.map(r=>r.nse_symbol),['OUTSIDE']);
});
test('local server parses requests and exposes the cookie API without starting workers in tests',async()=>{
  const app=await startServer({db,files:{},accessCode:code,port:0,automatic:false});
  try {
    const base=`http://127.0.0.1:${app.port}`;
    const page=await fetch(base+'/');assert.equal(page.status,200);
    assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);
    assert.match(await page.text(),/FINN — Portfolio & Research/);
    for(const name of ['/app.js','/styles.css'])assert.equal((await fetch(base+name)).status,200);
    for(const name of ['/.env','/backend/db.js'])assert.equal((await fetch(base+name)).status,404);
    const url=`http://127.0.0.1:${app.port}/api/app?resource=session`;
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Finn-Client':'web'},body:JSON.stringify({access_code:code})});
    assert.equal(response.status,200);assert.ok(response.headers.get('set-cookie'));
    assert.deepEqual(await response.json(),{authenticated:true});
  }finally{await app.close();}
});
test('local PDF preparation keeps draining while research and monitoring await slow requests',async()=>{
  const gate=Promise.withResolvers(),prepared=Promise.withResolvers();
  let calls=0,researchActive=false,monitorActive=false,timer;
  const app=await startServer({db,files:{},accessCode:code,port:0,
    async tick(_db,_files,options){monitorActive=options.localWorkers;await gate.promise;return {status:'ok'};},
    async runResearch(){researchActive=true;await gate.promise;return {status:'idle'};},
    async preparePages(){if(++calls===2)prepared.resolve();return {pagesSaved:1};}});
  try{
    await Promise.race([prepared.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PDF preparation was blocked')),3000);})]);
    assert.ok(monitorActive && researchActive);
  }finally{clearTimeout(timer);gate.resolve();await app.close();}
});

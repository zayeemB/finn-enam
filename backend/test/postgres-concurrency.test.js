import {test} from 'node:test';import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {openDatabase} from '../db.js';import {migrateDatabase} from '../migrations.js';import {createAppHandler} from '../app-api.js';
const base=process.env.PG_TEST_URL;
test('independent PostgreSQL connections serialize migrations, preserve legacy data and serve concurrent read-only API requests',{skip:!base,timeout:120000},async()=>{
 const admin=await openDatabase({connectionString:base}),schema='finn_test_'+randomUUID().replaceAll('-','');
 const url=new URL(base);url.searchParams.set('options','-c search_path='+schema);const connections=[];
 try{
  await admin.query('CREATE SCHEMA '+schema);
  const connect=async migration=>{const db=await openDatabase({connectionString:url.href,migration});connections.push(db);return db;};
  const legacy=await connect(true);
  // Reproduce an existing catalogue, not only an empty fresh installation.
  await legacy.execute(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const company=randomUUID(),job=randomUUID();
  await legacy.query("INSERT INTO companies VALUES ($1,'KEEP',NULL,'Preserved company')",[company]);
  await legacy.query("INSERT INTO research_jobs(id,company_id,question,status,result,error,error_kind,created_at) VALUES ($1,$2,'Saved question','failed','{\"title\":\"Preserved report\"}','Research page coverage mismatch','processing',now())",[job,company]);
  const document=randomUUID();
  await legacy.query("INSERT INTO research_documents(id,research_job_id,kind,title,source_url,discovery_url) VALUES ($1,$2,'presentation','Preserved source','https://www.bseindia.com/keep.pdf','https://www.screener.in/company/KEEP/')",[document,job]);
  await legacy.query("INSERT INTO portfolios(id,name) VALUES ('00000000-0000-4000-8000-000000000001','Existing workspace')");
  await legacy.query("INSERT INTO portfolio_settings(portfolio_id,digest_hours,digest_anchor_at,updated_at) VALUES ('00000000-0000-4000-8000-000000000001',36,now(),now())");
  const clients=await Promise.all(Array.from({length:8},()=>connect(true)));
  const ids=await Promise.all(clients.map(async c=>(await c.query('SELECT pg_backend_pid() AS id')).rows[0].id));assert.equal(new Set(ids).size,8);
  const results=await Promise.all(clients.map(c=>migrateDatabase(c)));
  assert.equal(results.reduce((n,r)=>n+r.applied.length,0),2);
  assert.equal(Number((await legacy.query('SELECT count(*) AS n FROM finn_schema_migrations')).rows[0].n),2);
  const saved=(await legacy.query('SELECT * FROM research_jobs WHERE id=$1',[job])).rows[0];assert.equal(saved.status,'failed');assert.equal(saved.result.title,'Preserved report');
  assert.equal((await legacy.query('SELECT kind FROM research_documents WHERE id=$1',[document])).rows[0].kind,'presentation');
  assert.equal((await legacy.query('SELECT digest_hours FROM portfolio_settings')).rows[0].digest_hours,36);
  let readOnly=false;
  const handler=createAppHandler({accessCode:'isolated-postgres-test',databaseFactory:async()=>{const db=await openDatabase({connectionString:url.href});if(readOnly)await db.query('SET default_transaction_read_only=on');return db;},triggerResearch:()=>{}});
  let cookie;
  const request=async(resource,method='GET',body)=>{
   const res={setHeader(k,v){if(k==='Set-Cookie')cookie=v.split(';')[0];},status(code){this.code=code;return this;},json(value){this.body=value;return this;}};
   await handler({method,body,query:{resource},headers:{host:'localhost','x-finn-client':'web',...(cookie?{cookie}:{})},socket:{remoteAddress:'127.0.0.1'}},res);return res;
  };
  assert.equal((await request('session','POST',{access_code:'isolated-postgres-test'})).code,200);readOnly=true;
  // Hold AccessShare on the table whose constraint used to be replaced on every open.
  // Any hidden ALTER TABLE on an API connection would block here.
  await legacy.query('BEGIN');await legacy.query('SELECT * FROM research_documents');
  try{
   const responses=await Promise.all(Array.from({length:32},(_,i)=>request(['portfolio','settings','research','status'][i%4])));
   assert.ok(responses.every(r=>r.code===200),JSON.stringify(responses.filter(r=>r.code!==200)));
  }finally{await legacy.query('ROLLBACK');}
  const row=(await legacy.query('SELECT checksum FROM finn_schema_migrations ORDER BY version LIMIT 1')).rows[0];
  await legacy.query("UPDATE finn_schema_migrations SET checksum='invalid' WHERE version='001-catalogue.sql'");
  await assert.rejects(()=>migrateDatabase(clients[0]),/checksum changed/);
  assert.equal((await legacy.query('SELECT result FROM research_jobs WHERE id=$1',[job])).rows[0].result.title,'Preserved report');
  await legacy.query("UPDATE finn_schema_migrations SET checksum=$1 WHERE version='001-catalogue.sql'",[row.checksum]);
  assert.deepEqual(await migrateDatabase(clients[1]),{applied:[]});
 }finally{await Promise.all(connections.map(c=>c.close()));await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
});
test('PostgreSQL TLS rejects an untrusted certificate and accepts the configured CA',{skip:!process.env.PG_TLS_TEST_URL,timeout:30000},async()=>{
 await assert.rejects(()=>openDatabase({connectionString:process.env.PG_TLS_UNTRUSTED_URL}),/certificate|self.signed|verify/i);
 const db=await openDatabase({connectionString:process.env.PG_TLS_TEST_URL});try{assert.equal((await db.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0].ssl,true);}finally{await db.close();}
});

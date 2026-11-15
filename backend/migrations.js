import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export const migrations=['001-catalogue.sql','002-workspace.sql'];
export async function migrateDatabase(db){
 return db.transaction(async tx=>{
  if(db.kind==='postgres'){
   await tx.query("SET LOCAL lock_timeout='15s'");
   await tx.query("SET LOCAL statement_timeout='120s'");
   // Transaction-scoped: safe with pooled URLs, released on commit/rollback/disconnect.
   await tx.query('SELECT pg_advisory_xact_lock(184437,1)');
  }
  await tx.query('CREATE TABLE IF NOT EXISTS finn_schema_migrations(version TEXT PRIMARY KEY,checksum TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied=[];
  for(const version of migrations){
   const sql=await readFile(new URL('./migrations/'+version,import.meta.url),'utf8'),checksum=createHash('sha256').update(sql).digest('hex');
   const prior=(await tx.query('SELECT checksum FROM finn_schema_migrations WHERE version=$1',[version])).rows[0];
   if(prior){if(prior.checksum!==checksum)throw Error('Applied migration checksum changed: '+version);continue;}
   await tx.execute(sql);
   await tx.query('INSERT INTO finn_schema_migrations(version,checksum) VALUES ($1,$2)',[version,checksum]);applied.push(version);
  }
  return {applied};
 });
}

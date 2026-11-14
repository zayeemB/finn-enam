import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export async function openDatabase({ connectionString = process.env.DATABASE_URL,
  dataDir = process.env.FINN_DATA_DIR || 'data/node', memory = false } = {}) {
  let driver;
  let local = false;
  if (connectionString) {
    const { default: pg } = await import('pg');
    driver = new pg.Client({ connectionString, connectionTimeoutMillis: 10000,
      query_timeout: 15000, statement_timeout: 15000 });
    await driver.connect();
  } else {
    if (process.env.VERCEL) throw new Error('DATABASE_URL is required on Vercel; local files are not durable');
    const { PGlite } = await import('@electric-sql/pglite');
    if (!memory) await mkdir(resolve(dataDir), { recursive: true });
    driver = new PGlite(memory ? undefined : resolve(dataDir, 'postgres'));
    await driver.waitReady;
    local = true;
  }
  // One connection is shared by HTTP reads and workers. Keep unrelated requests
  // outside each other's transactions while allowing queries inside a transaction.
  const context=new AsyncLocalStorage();let pending=Promise.resolve();
  const serial=fn=>{const result=pending.then(fn);pending=result.catch(()=>{});return result;};
  const db = {
    query: (sql, params = []) => context.getStore()===db?driver.query(sql,params):serial(()=>driver.query(sql,params)),
    transaction(fn) {
      if(context.getStore()===db) throw new Error('Nested transactions are not supported');
      return serial(()=>context.run(db,async()=>{
        await driver.query('BEGIN');
        try {const value=await fn(db);await driver.query('COMMIT');return value;}
        catch(error){await driver.query('ROLLBACK');throw error;}
      }));
    },
    close: () => serial(()=>local ? driver.close() : driver.end()),
  };
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  if (local) await driver.exec(schema); else await driver.query(schema);
  return db;
}

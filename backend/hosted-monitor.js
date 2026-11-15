import {waitUntil} from '@vercel/functions';
import {openDatabase} from './db.js';
import {openFiles} from './files.js';
import {runTick} from './monitor.js';
import {PORTFOLIO} from './repository.js';

export async function runHostedMonitoring({openDb=openDatabase,files=openFiles,run=runTick}={}) {
  const db=await openDb();
  try{return await run(db,await files(),{budgetMs:45000});}
  catch(error){
    await db.query('UPDATE monitoring_state SET last_error=$2,last_finished_at=now() WHERE portfolio_id=$1',[PORTFOLIO,error.message]);
    throw error;
  }finally{await db.close();}
}

// Polling advances bounded turns while the app is open. A scheduler is still required when closed.
export function hostedMonitoringTrigger({enabled=!!process.env.VERCEL,afterResponse=waitUntil,work=runHostedMonitoring,clock=()=>new Date()}={}) {
  let active,lastStarted=0;
  return async db=>{
    if(!enabled||active)return false;
    const now=+clock();
    if(now-lastStarted<15000)return false;
    const state=(await db.query(`SELECT m.*,s.monitoring_enabled FROM monitoring_state m
      JOIN portfolio_settings s USING(portfolio_id) WHERE m.portfolio_id=$1`,[PORTFOLIO])).rows[0];
    if(!state||(!state.monitoring_enabled&&!state.refresh_requested_at&&!state.phase)||
      +new Date(state.lease_expires_at)>now||now-+new Date(state.last_started_at)<15000)return false;
    // Recheck after the awaited query; concurrent requests can share this closure.
    if(active||now-lastStarted<15000)return false;
    lastStarted=now;
    active=Promise.resolve().then(work).catch(error=>console.error('Hosted monitoring failed:',error.message)).finally(()=>{active=null;});
    afterResponse(active);return true;
  };
}

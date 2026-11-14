import {randomUUID} from 'node:crypto';
import {PORTFOLIO,companies} from './repository.js';
import {initialiseApp,settings} from './app-state.js';
import {collect} from './collector.js';
import {extract} from './extraction/worker.js';
import {analyse} from './analysis/worker.js';
import {digest} from './outputs.js';
import {research} from './research/worker.js';

export async function publishNotifications(db,now=new Date()) {
  await db.query(`INSERT INTO notifications(id,portfolio_id,kind,reference_id,created_at)
    SELECT gen_random_uuid(),portfolio_id,'alert',id,$1 FROM alerts WHERE portfolio_id=$2
    ON CONFLICT(portfolio_id,kind,reference_id) DO NOTHING`,[now,PORTFOLIO]);
  await db.query(`INSERT INTO notifications(id,portfolio_id,kind,reference_id,created_at)
    SELECT gen_random_uuid(),portfolio_id,'digest',id,$1 FROM digest_runs WHERE portfolio_id=$2
    ON CONFLICT(portfolio_id,kind,reference_id) DO NOTHING`,[now,PORTFOLIO]);
}

export async function saveDueDigest(db,now=new Date()) {
  const config=await settings(db);
  const last=(await db.query('SELECT max(window_end) AS last FROM digest_runs WHERE portfolio_id=$1 AND window_end>=$2',[PORTFOLIO,config.digest_anchor_at])).rows[0].last;
  const start=new Date(last || config.digest_anchor_at),end=new Date(+start+config.digest_hours*3600000);
  let saved=null;
  if(+end<=+now) {
    const result=await digest(db,{start,end});
    saved=(await db.query(`INSERT INTO digest_runs VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(portfolio_id,window_start,window_end) DO NOTHING RETURNING id`,
    [randomUUID(),PORTFOLIO,start,end,JSON.stringify(result),now])).rows[0]?.id || null;
  }
  // An initially incomplete window becomes useful when late analysis finishes.
  const pending=(await db.query(`SELECT * FROM digest_runs WHERE portfolio_id=$1 AND
    EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') i WHERE i->>'processing_status'<>'completed')
    ORDER BY window_end DESC LIMIT 3`,[PORTFOLIO])).rows;
  for(const row of pending) await db.query('UPDATE digest_runs SET result=$2 WHERE id=$1',
    [row.id,JSON.stringify(await digest(db,{start:row.window_start,end:row.window_end}))]);
  return {created:saved,refreshed:pending.length};
}

export async function runTick(db,files,{budgetMs=45000,clock=()=>new Date(),services={},localWorkers=false}={}) {
  if(!Number.isSafeInteger(budgetMs)||budgetMs<2000||budgetMs>600000) throw new Error('Invalid tick budget');
  await initialiseApp(db,clock());
  const token=randomUUID(),now=clock();
  const state=(await db.query(`UPDATE monitoring_state SET lease_token=$2,lease_expires_at=$3,last_started_at=$4
    WHERE portfolio_id=$1 AND (lease_expires_at IS NULL OR lease_expires_at<=$4) RETURNING *`,
  [PORTFOLIO,token,new Date(+now+budgetMs+60000),now])).rows[0];
  if(!state) return {status:'busy'};
  const phases=['collect','extract','analyse','research','digest'];
  // Keep the persistent cursor compatible when switching between local and hosted scheduling.
  const advance=index=>{
    while(localWorkers && ['extract','research'].includes(phases[index]))index=(index+1)%phases.length;
    return index;
  };
  const index=advance(state.phase%phases.length),phase=phases[index];
  const next=advance((index+1)%phases.length);
  let result;
  try {
    const config=await settings(db);
    if(phase==='collect') {
      const due=state.refresh_requested_at || !state.last_collection_at || +now-+new Date(state.last_collection_at)>=config.monitoring_minutes*60000;
      if((config.monitoring_enabled || state.refresh_requested_at) && due && (await companies(db)).length) {
        const start=new Date(state.cycle_started_at || now);
        await db.query('UPDATE monitoring_state SET cycle_started_at=$3 WHERE portfolio_id=$1 AND lease_token=$2',[PORTFOLIO,token,start]);
        result=await (services.collect || collect)(db,files,{budgetMs,companyLimit:5});
        const uncovered=Number((await db.query(`SELECT count(*) AS n FROM portfolio_companies p LEFT JOIN collection_state s
          ON s.company_id=p.company_id AND s.source='nse' WHERE p.portfolio_id=$1 AND (s.last_attempt_at IS NULL OR s.last_attempt_at<$2)`,[PORTFOLIO,start])).rows[0].n);
        if(!uncovered) await db.query(`UPDATE monitoring_state SET cycle_started_at=NULL,last_collection_at=$3,
          refresh_requested_at=CASE WHEN refresh_requested_at<=$4 THEN NULL ELSE refresh_requested_at END
          WHERE portfolio_id=$1 AND lease_token=$2`,[PORTFOLIO,token,clock(),start]);
      } else result={status:'not_due_or_paused'};
    } else if(phase==='extract') result=await (services.extract || extract)(db,files,{budgetMs:Math.min(budgetMs,45000),pageLimit:40,jobLimit:3});
    else if(phase==='analyse') {
      const key=(process.env.ANALYSIS_PROVIDER || 'gemini')==='groq'?process.env.GROQ_API_KEY:process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if(!key && !services.analyse) result={status:'missing_model_key'};
      else result=await (services.analyse || analyse)(db,files,{budgetMs,requestTimeoutMs:Math.min(budgetMs-1000,300000),untilDisclosureComplete:false,callLimit:2,jobLimit:1});
    } else if(phase==='research') result=await (services.research || research)(db,files,{budgetMs});
    else result=await saveDueDigest(db,clock());
    await publishNotifications(db,clock());
    await db.query(`UPDATE monitoring_state SET phase=$3,last_finished_at=$4,last_result=$5,last_error=NULL,
      lease_token=NULL,lease_expires_at=NULL WHERE portfolio_id=$1 AND lease_token=$2`,
    [PORTFOLIO,token,next,clock(),JSON.stringify({phase,result})]);
    return {status:'ok',phase,result};
  }catch(error) {
    await db.query(`UPDATE monitoring_state SET phase=$3,last_finished_at=$4,last_error=$5,
      lease_token=NULL,lease_expires_at=NULL WHERE portfolio_id=$1 AND lease_token=$2`,[PORTFOLIO,token,next,clock(),error.message]);
    return {status:'failed',phase,error:error.message};
  }
}

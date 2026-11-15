import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {PORTFOLIO,companies,setPortfolio,snapshot} from './repository.js';
import {CATEGORIES} from './analysis/schema.js';
import {rules} from './outputs.js';
import {symbol} from './sources.js';

export async function initialiseApp(db,now=new Date()) {
  await db.query("INSERT INTO portfolios(id,name) VALUES ($1,'Demo portfolio') ON CONFLICT DO NOTHING",[PORTFOLIO]);
  await db.query(`INSERT INTO portfolio_settings(portfolio_id,digest_anchor_at,updated_at) VALUES ($1,$2,$2) ON CONFLICT DO NOTHING`,[PORTFOLIO,now]);
  await db.query('INSERT INTO monitoring_state(portfolio_id) VALUES ($1) ON CONFLICT DO NOTHING',[PORTFOLIO]);
  // Seed rules through the existing function only for a genuinely empty rule set.
  if(!(await rules(db)).length) await setPortfolio(db,(await companies(db)).map(c=>c.nse_symbol));
}
export const settingsSchema=z.object({monitoring_enabled:z.boolean().optional(),monitoring_minutes:z.number().int().min(1).max(1440).optional(),
  digest_hours:z.number().int().min(1).max(168).optional(),
  price_percent:z.number().positive().max(1000).optional(),volume_multiple:z.number().positive().max(1000).optional(),
  volume_sessions:z.number().int().min(2).max(250).optional(),announcement_categories:z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
  price_enabled:z.boolean().optional(),volume_enabled:z.boolean().optional(),announcement_enabled:z.boolean().optional()}).strict();
export async function settings(db) {
  return {...(await db.query('SELECT * FROM portfolio_settings WHERE portfolio_id=$1',[PORTFOLIO])).rows[0],rules:await rules(db)};
}
export async function watchlist(db) {
  const selected=await companies(db);
  const marketStates=(await db.query(`SELECT s.* FROM collection_state s JOIN portfolio_companies p ON p.company_id=s.company_id
    WHERE p.portfolio_id=$1 AND s.source='yahoo'`,[PORTFOLIO])).rows;
  const rows=(await db.query(`SELECT * FROM (SELECT o.*,row_number() OVER (PARTITION BY o.company_id,o.metric ORDER BY o.period_end DESC) AS rank
    FROM observations o JOIN portfolio_companies p ON p.company_id=o.company_id
    WHERE p.portfolio_id=$1 AND o.frequency='daily' AND o.scope='market' AND o.is_current AND o.metric IN ('close','volume')) latest
    WHERE rank<=2 ORDER BY company_id,metric,period_end DESC`,[PORTFOLIO])).rows;
  return selected.map(company=>{
    const closes=rows.filter(r=>r.company_id===company.id && r.metric==='close'),current=closes[0],previous=closes[1];
    const volume=rows.find(r=>r.company_id===company.id && r.metric==='volume' && +new Date(r.period_end)===+new Date(current?.period_end));
    const source=marketStates.find(s=>s.company_id===company.id);
    return {...company,market_status:{state:source?.last_error?'failed':source?.lease_expires_at&&+new Date(source.lease_expires_at)>Date.now()?'collecting':current?'available':'pending',
      last_attempt_at:source?.last_attempt_at||null,last_successful_fetch_at:source?.last_successful_fetch_at||null,error:source?.last_error||null},market:current?{close:Number(current.value),previous_close:previous?Number(previous.value):null,
      change_percent:previous && Number(previous.value)>0?(Number(current.value)/Number(previous.value)-1)*100:null,
      volume:volume?Number(volume.value):null,session_date:current.period_end,collected_at:current.collected_at,source_url:current.source_url}:null};
  });
}
export async function updateSettings(db,input,now=new Date()) {
  const patch=settingsSchema.parse(input);
  await db.transaction(async tx=>{
    const current=(await tx.query('SELECT * FROM portfolio_settings WHERE portfolio_id=$1 FOR UPDATE',[PORTFOLIO])).rows[0];
    await tx.query(`UPDATE portfolio_settings SET monitoring_enabled=$2,monitoring_minutes=$3,digest_hours=$4,
      digest_anchor_at=$5,updated_at=$6 WHERE portfolio_id=$1`,[PORTFOLIO,patch.monitoring_enabled??current.monitoring_enabled,
      patch.monitoring_minutes??current.monitoring_minutes,patch.digest_hours??current.digest_hours,
      patch.digest_hours && patch.digest_hours!==current.digest_hours?now:current.digest_anchor_at,now]);
    for(const rule of await rules(tx)) {
      const value={...rule.settings};let enabled=rule.enabled;
      if(rule.rule_type==='price_move'){value.percent=patch.price_percent??value.percent;enabled=patch.price_enabled??enabled;}
      if(rule.rule_type==='volume_spike'){value.multiple=patch.volume_multiple??value.multiple;value.sessions=patch.volume_sessions??value.sessions;enabled=patch.volume_enabled??enabled;}
      if(rule.rule_type==='announcement'){value.categories=patch.announcement_categories??value.categories;enabled=patch.announcement_enabled??enabled;}
      await tx.query('UPDATE alert_rules SET settings=$2,enabled=$3 WHERE id=$1',[rule.id,JSON.stringify(value),enabled]);
    }
  });return settings(db);
}
export async function changeCompany(db,name,remove=false,now=new Date()) {
  name=symbol(name);
  await db.transaction(async tx=>{
    await tx.query('SELECT id FROM portfolios WHERE id=$1 FOR UPDATE',[PORTFOLIO]);
    if(remove) await tx.query('DELETE FROM portfolio_companies WHERE portfolio_id=$1 AND company_id=(SELECT id FROM companies WHERE nse_symbol=$2)',[PORTFOLIO,name]);
    else {
      const count=Number((await tx.query('SELECT count(*) AS n FROM portfolio_companies WHERE portfolio_id=$1',[PORTFOLIO])).rows[0].n);
      const existing=(await tx.query('SELECT c.id FROM companies c JOIN portfolio_companies p ON p.company_id=c.id WHERE p.portfolio_id=$1 AND c.nse_symbol=$2',[PORTFOLIO,name])).rows[0];
      if(count>=50 && !existing) throw Object.assign(new Error('Demo portfolio supports up to 50 companies'),{status:400});
      const company=(await tx.query('INSERT INTO companies(id,nse_symbol,name) VALUES ($1,$2,$2) ON CONFLICT(nse_symbol) DO UPDATE SET nse_symbol=excluded.nse_symbol RETURNING id',[randomUUID(),name])).rows[0];
      await tx.query('INSERT INTO portfolio_companies(portfolio_id,company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[PORTFOLIO,company.id]);
    }
    await tx.query('UPDATE monitoring_state SET refresh_requested_at=$2 WHERE portfolio_id=$1',[PORTFOLIO,now]);
  });return companies(db);
}
export async function status(db) {
  const state=await snapshot(db);
  state.collection=state.collection.map(({lease_token,...row})=>row);
  return {...state,monitor:(await db.query('SELECT * FROM monitoring_state WHERE portfolio_id=$1',[PORTFOLIO])).rows.map(({lease_token,...row})=>row)[0],
    research:(await db.query('SELECT status,count(*) AS count FROM research_jobs GROUP BY status')).rows,
    scheduler_note:'Updates run locally with npm run dev. On Vercel, an open signed-in app advances monitoring; a scheduler must invoke the protected tick endpoint to continue while the app is closed.'};
}

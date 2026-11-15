import { randomUUID } from 'node:crypto';
import { PORTFOLIO, jobInputIsCurrent } from './repository.js';
import { indiaDay } from './sources.js';

export async function rules(db) { return (await db.query('SELECT * FROM alert_rules WHERE portfolio_id=$1 ORDER BY rule_type', [PORTFOLIO])).rows; }
export async function configureRule(db, type, settings) {
  if (type === 'price_move' && (!Number.isFinite(settings.percent) || settings.percent <= 0)) throw new Error('Price threshold must be positive');
  if (type === 'volume_spike' && (!Number.isFinite(settings.multiple) || settings.multiple <= 0 || !Number.isInteger(settings.sessions) || settings.sessions < 2 || settings.sessions > 250)) throw new Error('Volume rule needs a positive multiple and 2–250 prior sessions');
  await db.query('UPDATE alert_rules SET settings=$3 WHERE portfolio_id=$1 AND rule_type=$2', [PORTFOLIO, type, JSON.stringify(settings)]);
}
export async function alerts(db) { return (await db.query('SELECT a.*,c.nse_symbol FROM alerts a JOIN companies c ON c.id=a.company_id WHERE portfolio_id=$1 ORDER BY created_at DESC,id', [PORTFOLIO])).rows; }
async function writeAlert(tx, { companyId, portfolioId, ruleId, eventId = null, version = null, session = null, message, details, key, now }) {
  return (await tx.query(`INSERT INTO alerts(id,company_id,portfolio_id,rule_id,event_id,event_version,market_session,message,trigger_details,dedup_key,created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`,
  [randomUUID(), companyId, portfolioId, ruleId, eventId, version, session, message, JSON.stringify(details), key, now])).rows.length;
}
export async function announcementAlerts(tx, event, evidence, now) {
  if (event.importance !== 'high') return 0;
  const rows = (await tx.query(`SELECT r.* FROM alert_rules r JOIN portfolio_companies p ON p.portfolio_id=r.portfolio_id
    WHERE p.company_id=$1 AND r.rule_type='announcement' AND r.enabled`, [event.company_id])).rows;
  let count = 0;
  for (const rule of rows) if (rule.settings.categories.includes(event.category)) count += await writeAlert(tx, {
    companyId: event.company_id, portfolioId: rule.portfolio_id, ruleId: rule.id, eventId: event.id, version: event.version,
    key: `${rule.portfolio_id}:${rule.id}:event:${event.id}:${event.version}`, now,
    message: event.summary, details: { headline: event.title, why_it_matters: event.details.why_it_matters,
      trigger: event.importance_reason, evidence, limitations:event.details.limitations || [] } });
  return count;
}

function hasSplit(rows, from, to) {
  return rows.some(row => Object.values(row.evidence_snapshot?.corporate_actions?.splits || {}).some(a => {
    const day = indiaDay(new Date(a.date * 1000)); return day >= from && day <= to;
  }));
}
export async function evaluateMarketAlerts(db, now = new Date()) {
  let count = 0;
  const selected = (await db.query('SELECT c.* FROM companies c JOIN portfolio_companies p ON p.company_id=c.id WHERE p.portfolio_id=$1', [PORTFOLIO])).rows;
  for (const company of selected) for (const rule of await rules(db)) {
    if (!rule.enabled || !['price_move','volume_spike'].includes(rule.rule_type)) continue;
    const metric = rule.rule_type === 'price_move' ? 'close' : 'volume';
    const sessions = metric === 'close' ? 1 : rule.settings.sessions;
    const history = (await db.query(`SELECT *,period_end::text AS session FROM observations WHERE company_id=$1 AND metric=$2
      AND frequency='daily' AND scope='market' AND is_current ORDER BY period_end DESC LIMIT $3`, [company.id, metric, sessions + 1])).rows;
    if (history.length < sessions + 1) continue;
    const [current, ...prior] = history;
    const age = (+new Date(indiaDay(now)) - +new Date(current.session)) / 86400000;
    if (age < 0 || age > 4 || hasSplit(history, metric === 'close' ? current.session : prior.at(-1).session, current.session)) continue;
    const value = Number(current.value), baseline = prior.reduce((sum, p) => sum + Number(p.value), 0) / sessions;
    if (baseline <= 0) continue;
    const observed = metric === 'close' ? (value / baseline - 1) * 100 : value / baseline;
    const threshold = metric === 'close' ? rule.settings.percent : rule.settings.multiple;
    if ((metric === 'close' ? Math.abs(observed) : observed) <= threshold) continue;
    count += await writeAlert(db, { companyId: company.id, portfolioId: PORTFOLIO, ruleId: rule.id,
      session: current.session, key: `${PORTFOLIO}:${rule.id}:market:${company.id}:${current.session}`, now,
      message: metric === 'close' ? `${company.nse_symbol} closed ${observed >= 0 ? '+' : ''}${observed.toFixed(2)}% on ${current.session}.`
        : `${company.nse_symbol} volume was ${observed.toFixed(2)}× its prior ${sessions}-session average.`,
      details: { metric, observed_value: value, baseline, baseline_sessions: sessions,
        threshold, observed_change: observed, session: current.session,
        source_url: current.source_url, why_it_matters: 'Unusual completed-session market activity; this does not establish a cause.' } });
  }
  return count;
}

function previousQuarter(day, months) {
  const date = new Date(day), index = date.getUTCFullYear() * 12 + date.getUTCMonth() - months;
  return new Date(Date.UTC(Math.floor(index / 12), index % 12 + 1, 0)).toISOString().slice(0,10);
}
export async function financialCard(db, companyId, observations) {
  const current = observations.filter(o => o.frequency === 'quarterly');
  const latest = current.map(o => o.period_end).sort().at(-1);
  if (!latest) return null;
  const scopes = [...new Set(current.filter(o => o.period_end === latest).map(o => o.scope))];
  const cards = [];
  for (const scope of scopes) {
    const rows = [];
    for (const metric of ['revenue','ebitda','pbt','pat']) {
      const fact = current.find(o => o.metric === metric && o.period_end === latest && o.scope === scope);
      if (!fact) { rows.push({ metric, value: null, status: 'unavailable' }); continue; }
      const comparisons = {};
      for (const [name, months] of [['qoq',3],['yoy',12]]) {
        const previous = (await db.query(`SELECT *,period_end::text AS day FROM observations WHERE company_id=$1 AND metric=$2
          AND frequency='quarterly' AND scope=$3 AND unit=$4 AND period_end=$5 AND is_current`,
        [companyId, metric, scope, fact.unit, previousQuarter(latest, months)])).rows[0];
        comparisons[name] = !previous ? { status: 'unavailable', change_percent: null }
          : { previous_value: Number(previous.value), source_url: previous.source_url,
            change_percent: Number(previous.value) > 0 ? (fact.value / Number(previous.value) - 1) * 100 : null,
            status: Number(previous.value) > 0 ? 'available' : 'zero_or_negative_base' };
      }
      rows.push({ metric, value: fact.value, unit: fact.unit, ...comparisons });
    }
    cards.push({ period_end: latest, scope, figures: rows });
  }
  return cards;
}

export async function digest(db, { start, end = new Date(), hours = 24, portfolioId = PORTFOLIO } = {}) {
  for (const value of [start,end]) if (value!==undefined && !(value instanceof Date) && (typeof value!=='string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))) throw new Error('Digest timestamps must include a timezone');
  end = new Date(end); start = start ? new Date(start) : new Date(+end - hours * 3600000);
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || +start >= +end) throw new Error('Digest requires a valid increasing time window');
  const disclosures = (await db.query(`SELECT d.*,c.nse_symbol FROM disclosures d JOIN companies c ON c.id=d.company_id
    JOIN portfolio_companies p ON p.company_id=d.company_id WHERE p.portfolio_id=$1 AND d.collection_mode='monitoring' AND d.published_at>=$2 AND d.published_at<$3
    ORDER BY d.published_at DESC`, [portfolioId,start,end])).rows;
  const items = [];
  for (const disclosure of disclosures) {
    const jobs = (await db.query("SELECT * FROM processing_jobs WHERE disclosure_id=$1 AND job_type='analyse' ORDER BY created_at DESC", [disclosure.id])).rows;
    let job;
    for (const candidate of jobs) if (await jobInputIsCurrent(db, candidate)) { job = candidate; break; }
    const assets = (await db.query('SELECT id,source_url,download_status,extraction_status,extraction_error FROM assets WHERE disclosure_id=$1 AND is_current', [disclosure.id])).rows;
    const savedJob=job?.status==='completed'?job:jobs.filter(j=>j.completed_at && j.output?.result)
      .sort((a,b)=>+new Date(b.completed_at)-+new Date(a.completed_at))[0];
    const links = savedJob ? (await db.query('SELECT * FROM analysis_event_links WHERE job_id=$1', [savedJob.id])).rows : [];
    items.push({ id: disclosure.id, company: disclosure.nse_symbol, title: disclosure.title,
      published_at: disclosure.published_at, source_url: disclosure.source_url,
      processing_status: job?.status || 'awaiting_extraction', error: job?.error || null, assets,
      analysis: {available:!!savedJob,analysed_at:savedJob?.completed_at || null,
        is_current:!!savedJob && savedJob.id===job?.id && job.status==='completed',
        model:savedJob?.output?.model || savedJob?.model || null,models_used:savedJob?.output?.models_used || (savedJob?[savedJob.model]:[]),
        source:savedJob?.output?.source || null,coverage:savedJob?.output?.coverage||null,
        note:savedJob && (savedJob.id!==job?.id || job?.status!=='completed')
          ? 'Previously saved analysis; newer source data is awaiting analysis. Figures and conclusions may have changed.' : null},
      developments: links.map(link => ({ event_id: link.event_id, version: link.event_version,
        relationship: link.relationship, ...link.presentation,
        analysed_at:savedJob.completed_at,analysis_is_current:savedJob.id===job?.id && job.status==='completed' })),
      limitations: savedJob?.output?.result?.limitations || [] });
  }
  const priority = item => item.developments.length ? Math.max(...item.developments.map(d => ({ high:2,normal:1,routine:0 })[d.importance])) : 1;
  items.sort((a,b) => priority(b)-priority(a) || +new Date(b.published_at)- +new Date(a.published_at));
  const groups = new Map();
  for (const item of items) for (const development of item.developments) {
    const key = `${development.event_id}:${development.version}`;
    if (!groups.has(key)) groups.set(key, { ...development, company: item.company, sources: [] });
    groups.get(key).analysis_is_current ||= development.analysis_is_current;
    groups.get(key).sources.push({ disclosure_id:item.id, source_url:item.source_url, published_at:item.published_at,
      analysed_at:item.analysis.analysed_at,analysis_is_current:item.analysis.is_current });
  }
  const recentAlerts=(await db.query(`SELECT a.*,c.nse_symbol FROM alerts a JOIN companies c ON c.id=a.company_id
    WHERE portfolio_id=$1 AND created_at>=$2 AND created_at<$3 ORDER BY created_at DESC`,[portfolioId,start,end])).rows;
  const marketSnapshot=(await db.query(`SELECT DISTINCT ON (o.company_id,o.metric) c.nse_symbol,o.metric,o.value,o.unit,
    o.period_end::text AS session_date,o.collected_at,o.source_url FROM observations o JOIN companies c ON c.id=o.company_id
    JOIN portfolio_companies p ON p.company_id=c.id WHERE p.portfolio_id=$1 AND o.frequency='daily'
    AND o.scope='market' AND o.is_current AND o.metric IN ('close','volume')
    ORDER BY o.company_id,o.metric,o.period_end DESC`,[portfolioId])).rows;
  const collection=(await db.query(`SELECT c.nse_symbol,s.last_successful_fetch_at,s.last_error FROM portfolio_companies p
    JOIN companies c ON c.id=p.company_id LEFT JOIN collection_state s ON s.company_id=c.id AND s.source='nse'
    WHERE p.portfolio_id=$1`,[portfolioId])).rows;
  const priced=new Set(marketSnapshot.filter(r=>r.metric==='close').map(r=>r.nse_symbol));
  const coverage={companies:collection.length,companies_with_prices:priced.size,
    companies_checked:collection.filter(c=>!c.last_error&&c.last_successful_fetch_at&&+new Date(c.last_successful_fetch_at)>=+start).length,
    collection_errors:collection.filter(c=>c.last_error).map(c=>({company:c.nse_symbol,error:c.last_error}))};
  coverage.pending_companies=coverage.companies-coverage.companies_checked;
  // Available even when the selected window contains no completed analysis yet.
  // Explicitly separate saved company context from developments inside the digest window.
  const savedRows=(await db.query(`SELECT DISTINCT ON (d.company_id) j.*,c.nse_symbol,d.title,d.source_url,d.published_at
    FROM processing_jobs j JOIN disclosures d ON d.id=j.disclosure_id JOIN companies c ON c.id=d.company_id
    JOIN portfolio_companies p ON p.company_id=c.id WHERE p.portfolio_id=$1 AND j.job_type='analyse'
    AND j.completed_at IS NOT NULL AND j.output->'result' IS NOT NULL
    ORDER BY d.company_id,j.completed_at DESC,j.id`,[portfolioId])).rows;
  const savedCompanyResults=[];
  for (const row of savedRows) {
    const companyDisclosures=(await db.query(`SELECT id FROM disclosures WHERE collection_mode='monitoring' AND company_id=(SELECT company_id FROM disclosures WHERE id=$1)`,[row.disclosure_id])).rows;
    const completed=(await db.query(`SELECT j.* FROM processing_jobs j JOIN disclosures d ON d.id=j.disclosure_id
      WHERE d.company_id=(SELECT company_id FROM disclosures WHERE id=$1) AND j.job_type='analyse' AND j.status='completed'`,[row.disclosure_id])).rows;
    const currentIds=new Set();
    for (const candidate of completed) if(await jobInputIsCurrent(db,candidate)) currentIds.add(candidate.disclosure_id);
    savedCompanyResults.push({company:row.nse_symbol,disclosure_id:row.disclosure_id,title:row.output.source?.title || row.title,source_url:row.output.source?.source_url || row.source_url,
      published_at:row.output.source?.published_at || row.published_at,analysed_at:row.completed_at,model:row.output.model || row.model,
      models_used:row.output.models_used || [row.model],result:row.output.result,
      input_is_current:await jobInputIsCurrent(db,row),pending_disclosures:companyDisclosures.filter(d=>!currentIds.has(d.id)).length,
      note:'Latest saved analysis at request time, not necessarily inside the digest window; check publication and analysis timestamps.'});
  }
  return { from:start.toISOString(),to:end.toISOString(),disclosure_count:items.length,coverage,
    saved_company_results:savedCompanyResults,
    items, grouped_developments:[...groups.values()], routine_collapsed:items.filter(i => i.developments.length && i.developments.every(d => d.importance==='routine')).map(i => i.id),
    alerts_created_in_window:recentAlerts,latest_market_snapshot:marketSnapshot,
    market_snapshot_note:'Latest saved completed sessions at request time, labelled by session date and collection time; this is not a historical as-of replay.' };
}

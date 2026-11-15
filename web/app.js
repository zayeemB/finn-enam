const $=selector=>document.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const human=value=>String(value??'').replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase());
const number=(value,options={})=>value===null||value===undefined||!Number.isFinite(Number(value))?'—':new Intl.NumberFormat('en-IN',{maximumFractionDigits:2,...options}).format(Number(value));
const money=value=>value===null||value===undefined?'—':number(value,{style:'currency',currency:'INR',minimumFractionDigits:2});
const compact=value=>number(value,{notation:'compact',maximumFractionDigits:1});
const when=(value,full=false)=>!value||!Number.isFinite(+new Date(value))?'Not yet':new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',...(full?{hour:'numeric',minute:'2-digit'}:{}),timeZone:'Asia/Kolkata'}).format(new Date(value));
const percent=value=>value===null||value===undefined?'—':`${Number(value)>=0?'+':''}${number(value,{minimumFractionDigits:2})}%`;
const sign=value=>value===null||value===undefined?'muted':Number(value)>=0?'positive':'negative';
const url=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.href:null;}catch{return null;}};
const sourceLink=(href,label='Open source ↗')=>url(href)?`<a class="source-link" href="${esc(url(href))}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`:'';
const labels={portfolio:'Portfolio',research:'Research',digests:'Digests',alerts:'Alerts'};
const categories=['results','M&A','fund_raise','management_change','litigation','insider_trading','earnings_call','investor_meetings','credit_rating','dividend','bonus_split','capex','press_release','postal_ballot','agm_egm','pledging','annual_report','guidance','routine','unclassified'];
const topicLabels={capital_allocation:'Capital allocation',business_snapshot:'Business snapshot',financial_snapshot:'Financial snapshot',trajectory:'Trajectory',balance_sheet:'Balance sheet',cash_quality:'Cash quality',narrative_vs_numbers:'Narrative vs. numbers',guidance:'Management guidance',bull_vs_bear:'Bull & bear considerations'};
const state={authenticated:false,portfolio:null,settings:null,status:null,alerts:[],notifications:[],research:[],digests:[],digest:null,job:null,
  selectedJob:null,view:'portfolio',window:null,loading:false,loadedAt:null,error:null,tickerDraft:'',starting:false,
  draft:{symbol:'',question:'',source_policy:'primary'},pendingPaint:false,refreshing:false,selectedDigest:null};
let pollTimer,toastTimer,modalVersion=0;
let paintedKey;

async function api(resource,{method='GET',body,params={}}={}) {
  const query=new URLSearchParams({resource,...params});
  let response;
  try{response=await fetch(`/api/app?${query}`,{method,credentials:'same-origin',signal:AbortSignal.timeout(20000),
    headers:method==='GET'?{}:{'Content-Type':'application/json','X-Finn-Client':'web'},...(method!=='GET'?{body:JSON.stringify(body??{})}:{})});}
  catch(error){throw new Error(error.name==='TimeoutError'?'The backend took too long to respond. Please try again.':'Cannot reach the backend. Check that the server is running.');}
  const data=await response.json().catch(()=>({error:'The backend returned an unreadable response.'}));
  if(!response.ok){if(response.status===401&&resource!=='session')showLogin();throw new Error(data.error||`Request failed (${response.status})`);}
  return data;
}
function toast(message,error=false){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').className=`toast${error?' error':''}`;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,error?8000:4500);}
function badge(status){const names={queued:'Queued',waiting:'In progress',running:'Running',completed:'Complete',partial:'Partial',failed:'Needs attention',awaiting_extraction:'Preparing',superseded:'Updated source'};return `<span class="badge ${esc(status)}">${esc(names[status]||human(status))}</span>`;}
function empty(title,description,action=''){return `<div class="empty"><div class="empty-icon" aria-hidden="true">⌁</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;}
function researchBadge(job){return job.status==='waiting'&&job.next_attempt_at?'<span class="badge waiting">Automatic retry</span>':badge(job.status);}
function showLogin(){state.authenticated=false;clearTimeout(pollTimer);$('#workspace').hidden=true;$('#auth').hidden=false;$('#auth-check').hidden=true;$('#login-form').hidden=false;if($('#modal').open)$('#modal').close();}
async function checkSession(){
  $('#auth-check').hidden=false;$('#login-form').hidden=true;$('#auth-error').hidden=true;$('#connection-retry').hidden=true;
  try{const session=await api('session');if(session.authenticated)await enterWorkspace();else showLogin();}
  catch(error){$('#auth-check').hidden=true;$('#auth-error').textContent=error.message;$('#auth-error').hidden=false;$('#connection-retry').hidden=false;}
}
async function enterWorkspace(){state.authenticated=true;$('#auth').hidden=true;$('#workspace').hidden=false;readRoute();await load();schedulePoll();}
function schedulePoll(){clearTimeout(pollTimer);if(!state.authenticated)return;pollTimer=setTimeout(async()=>{if(!document.hidden)await load();schedulePoll();},6000);}
async function load({force=false}={}) {
  if(!state.authenticated)return;if(state.loading){if(force)state.reloadNeeded=true;return;}state.loading=true;
  const selected=state.selectedJob;
  const resources=['portfolio','settings','status','alerts','notifications','research','digests','digest'];
  const requests=resources.map(resource=>api(resource,{params:resource==='digest'&&state.window?{hours:String(state.window)}:{}}));
  if(selected)requests.push(api('research',{params:{id:selected}}));
  const results=await Promise.allSettled(requests);
  if(!state.authenticated){state.loading=false;return;}
  results.forEach((result,i)=>{if(result.status==='fulfilled'){
    if(i<resources.length)state[resources[i]]=result.value;
    else if(selected===state.selectedJob)state.job=result.value;
  }});
  const failures=results.filter(r=>r.status==='rejected');
  if(state.selectedDigest)state.selectedDigest=state.digests.find(d=>d.id===state.selectedDigest.id)||state.selectedDigest;
  state.error=failures.length?failures[0].reason.message:null;
  if(!failures.length)state.loadedAt=new Date();
  state.loading=false;paintChrome();paint();
  if(state.reloadNeeded){state.reloadNeeded=false;queueMicrotask(()=>load({force:true}));}
}
function readRoute(){const [view,id]=location.hash.slice(1).split('/');state.view=labels[view]?view:'portfolio';const selected=state.view==='research'&&/^[a-f0-9-]{36}$/i.test(id||'')?id:null;if(selected!==state.selectedJob){state.selectedJob=selected;state.job=null;}}
function paintChrome(){
  for(const a of document.querySelectorAll('[data-nav]')){a.classList.toggle('active',a.dataset.nav===state.view);if(a.dataset.nav===state.view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');}
  $('#breadcrumb-current').textContent=labels[state.view];$('#company-count').textContent=state.portfolio?.length??'—';
  const unread=state.notifications.filter(n=>n.kind==='alert'&&!n.read_at).length;$('#unread-count').textContent=unread;$('#unread-count').hidden=!unread;
  $('#sync-label').textContent=state.loadedAt?`Synced ${when(state.loadedAt,true)} IST`:'Loading saved data…';
  const enabled=state.settings?.monitoring_enabled;$('#connection-label').textContent=state.error?'Connection interrupted':enabled?'Watcher enabled':'Monitoring paused';
  $('#connection-dot').className=`status-dot${state.error?' error':enabled?'':' off'}`;
  $('#offline-banner').hidden=!state.error;$('#offline-banner').textContent=state.error?`${state.error} Showing the last data loaded.`:'';
}
function paint(force=false){
  // Polling shouldn't rebuild unchanged buttons/forms every few seconds. Only
  // visible data changes invalidate a view; sync timestamps update separately.
  const watcher=[state.settings,state.status?.jobs,state.status?.processingErrors,state.status?.monitor];
  const digest=[state.digest?.items,state.digest?.saved_company_results];
  const key=JSON.stringify([state.view,state.view==='research'?[state.selectedJob,state.job,state.research]:
    state.view==='portfolio'?[state.portfolio,watcher,digest,state.notifications]:
    state.view==='digests'?[watcher,digest,state.window,state.selectedDigest,state.digests,Math.floor(Date.now()/60000)]:
    [state.alerts,state.notifications,watcher]]);
  if(!force&&key===paintedKey){state.pendingPaint=false;return;}
  const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if(!force&&(editing||$('#modal').open)){
    if(editing&&state.view==='research'&&$('#research-output'))$('#research-output').innerHTML=researchResult();
    state.pendingPaint=true;return;
  }
  state.pendingPaint=false;
  if(state.portfolio===null){$('#main').innerHTML=`<div class="page-loading"><span class="spinner"></span> ${state.error?'Waiting for the backend…':'Loading your workspace…'}</div>`;return;}
  $('#main').innerHTML=({portfolio:portfolioView,research:researchView,digests:digestsView,alerts:alertsView}[state.view])();paintedKey=key;
}
function heading(title,description,actions=''){return `<div class="page-heading"><div><div class="eyebrow">${state.view==='research'?'FOLLOW YOUR CURIOSITY':'YOUR DAILY PERSPECTIVE'}</div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${actions?`<div class="heading-actions">${actions}</div>`:''}</div>`;}
function stat(name,value,detail){return `<div class="stat corner"><div class="stat-name">${esc(name)}</div><div class="stat-value numeric">${esc(value)}</div><div class="stat-detail">${esc(detail)}</div></div>`;}
function refreshButton(){return `<button class="button secondary" data-action="settings">Watcher settings</button><button class="button primary" data-action="refresh" ${state.refreshing?'disabled':''}>${state.refreshing?'<span class="spinner"></span>':'<span aria-hidden="true">↻</span>'} Refresh updates</button>`;}
function pendingCount(){return (state.status?.jobs||[]).filter(j=>['queued','running','failed'].includes(j.status)).reduce((n,j)=>n+Number(j.count),0);}
function portfolioView(){
  const items=state.portfolio,covered=items.filter(c=>c.market).length,unread=state.notifications.filter(n=>n.kind==='alert'&&!n.read_at).length;
  return heading('Your portfolio, in focus.','A watchlist of companies. Important developments, with the sources to back them up.',refreshButton())+
    `<div class="stats-grid">${stat('Companies watching',items.length,'NSE-listed equities')}${stat('Price coverage',`${covered} / ${items.length}`,'Saved end-of-day sessions')}${stat('Unread alerts',unread,'Your configured thresholds')}${stat('Documents in progress',pendingCount(),'Queued, running, or needing attention')}</div>
    <div class="content-grid"><div><section class="panel"><div class="panel-head"><div><h2>Your watchlist</h2><p>Prices and daily changes from completed market sessions</p></div><span class="badge">EOD</span></div>
    <form id="add-company" class="add-company"><label for="ticker">Add a company</label><div class="input-row"><input id="ticker" name="symbol" placeholder="NSE symbol, e.g. INFY" value="${esc(state.tickerDraft)}" maxlength="40" autocomplete="off" autocapitalize="characters" required><button class="button secondary compact" type="submit">+ Watch</button></div></form>
    ${items.length?`<div class="table-wrap"><table><thead><tr><th scope="col">COMPANY</th><th scope="col">EOD CLOSE</th><th scope="col">DAILY CHANGE</th><th scope="col">VOLUME</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>${items.map(companyRow).join('')}</tbody></table></div>`:empty('Start with a company','Add an NSE ticker above. The watcher will collect its announcements and end-of-day data.')}
    <div class="panel-footer"><span>${items.length} compan${items.length===1?'y':'ies'} tracked</span><span>No live or intraday prices</span></div></section>
    <section class="panel"><div class="panel-head"><div><h2>What changed</h2><p>Portfolio announcements · last ${state.window||state.settings?.digest_hours||24} hours</p></div><a class="text-button" href="#digests">View digest ↗</a></div>${digestFeed(state.digest,{preview:true})}</section>
    ${savedContext()}</div><aside class="watcher-aside">${watcherPanel()}<div class="accent-panel"><div class="eyebrow">BEYOND THE HEADLINES</div><h2>Ask a better<br>question.</h2><p>Dig into annual reports and earnings calls, with evidence a click away.</p><a class="text-button" href="#research">Start researching ↗</a></div></aside></div>`;
}
function companyRow(c){const m=c.market;return `<tr><td><div class="company-cell"><span class="ticker-logo" aria-hidden="true">${esc(c.nse_symbol.slice(0,2))}</span><div><button class="company-button" data-action="company" data-symbol="${esc(c.nse_symbol)}">${esc(c.nse_symbol)}</button><div class="company-name">${esc(c.name!==c.nse_symbol?c.name:'NSE · Equity')}</div></div></div></td><td class="numeric">${money(m?.close)}<div class="cell-sub">${m?`Session ${when(m.session_date)}`:'Awaiting price data'}</div></td><td class="numeric ${sign(m?.change_percent)}">${percent(m?.change_percent)}</td><td class="numeric">${compact(m?.volume)}</td><td><div class="row-actions"><button class="icon-button" title="View ${esc(c.nse_symbol)}" aria-label="View ${esc(c.nse_symbol)}" data-action="company" data-symbol="${esc(c.nse_symbol)}">↗</button><button class="icon-button" title="Stop watching ${esc(c.nse_symbol)}" aria-label="Stop watching ${esc(c.nse_symbol)}" data-action="remove" data-symbol="${esc(c.nse_symbol)}">×</button></div></td></tr>`;}
function watcherPanel(){const monitor=state.status?.monitor,s=state.settings,r=type=>s?.rules?.find(r=>r.rule_type===type),enabled=s?.monitoring_enabled;
  const running=monitor?.lease_expires_at&&+new Date(monitor.lease_expires_at)>Date.now();
  return `<section class="panel side-panel"><h2>The portfolio watcher</h2><div class="watcher-status"><span class="status-dot ${enabled?'':'off'}"></span>${enabled?'Monitoring enabled':'Monitoring paused'}</div><p class="side-note">${running?'A background step is running. You can keep using the app.':monitor?.last_finished_at?`Last step completed ${when(monitor.last_finished_at,true)} IST.`:'Waiting for the first background check.'}</p><div class="side-rule"></div><div class="step-line"><span>Check interval</span><strong>${s?.monitoring_minutes??'—'} min</strong></div><div class="step-line"><span>Digest window</span><strong>${s?.digest_hours??'—'} hours</strong></div><div class="step-line"><span>Daily price move</span><strong>${r('price_move')?.enabled?`±${number(r('price_move').settings.percent)}%`:'Off'}</strong></div><div class="step-line"><span>Volume spike</span><strong>${r('volume_spike')?.enabled?`${number(r('volume_spike').settings.multiple)}× average`:'Off'}</strong></div><div class="side-rule"></div><p class="side-note">Background updates run while the local server is open. Alerts appear in this workspace.</p><button class="button secondary" data-action="toggle-monitor">${enabled?'Pause monitoring':'Resume monitoring'}</button><button class="text-button" data-action="status" style="margin-top:16px">View processing status ↗</button></section>`;
}
function digestFeed(digest,{preview=false}={}){
  if(!digest)return empty('Loading the digest','Fetching saved announcements from the backend.');
  const main=digest.items.filter(item=>!item.developments?.length||!item.developments.every(d=>d.importance==='routine'));
  const routine=digest.items.filter(item=>item.developments?.length&&item.developments.every(d=>d.importance==='routine'));
  const shown=preview?main.slice(0,4):main;
  return `${digest.items.length?`<div class="feed-list">${shown.map(disclosureCard).join('')}</div>`:empty('No filings saved in this window','Collection may still be in progress. Check watcher status, or explore earlier saved analyses below.')}
    ${preview&&main.length>4?`<div class="panel-footer"><a class="text-button" href="#digests">View all ${main.length} developments ↗</a></div>`:''}
    ${routine.length?`<details class="routine"><summary>${routine.length} routine announcement${routine.length===1?'':'s'}</summary><div>${routine.map(disclosureCard).join('')}</div></details>`:''}`;
}
function disclosureCard(item){return `<article class="feed-item"><div class="feed-meta"><strong>${esc(item.company)}</strong><span>${when(item.published_at,true)} IST</span>${badge(item.processing_status)}</div>
  ${item.analysis?.available&&!item.analysis.is_current?'<div class="notice">Previously saved analysis. The updated source is awaiting analysis.</div>':''}
  ${item.developments?.length?item.developments.map((d,index)=>`<div><h3>${esc(d.headline)}</h3><p>${esc(d.summary)}</p>${d.importance==='high'?'<span class="badge high">Priority</span>':''} <button class="text-button" data-action="digest-evidence" data-disclosure="${esc(item.id)}" data-index="${index}">View evidence</button></div>`).join(''):`<h3>${esc(item.title)}</h3><p>${item.processing_status==='failed'?'Analysis is paused. Check processing status for the error and retry timing.':'This filing is saved; its analysis is not ready yet.'}</p>`}
  <div class="source-row" style="margin-top:11px">${sourceLink(item.source_url,'Original filing ↗')}<span class="muted small">${item.analysis?.analysed_at?`Analysed ${when(item.analysis.analysed_at,true)} IST`:''}</span></div></article>`;}
function savedContext(){const rows=state.digest?.saved_company_results||[];if(!rows.length)return '';return `<section class="panel"><div class="panel-head"><div><h2>Last saved analysis</h2><p>Company context · may fall outside the selected digest window</p></div></div><div class="feed-list">${rows.map(r=>`<article class="feed-item"><div class="feed-meta"><strong>${esc(r.company)}</strong><span>Analysed ${when(r.analysed_at,true)} IST</span>${!r.input_is_current?'<span class="badge partial">Updated source pending</span>':''}</div><h3>${esc(r.title)}</h3><p>${esc(r.result?.developments?.[0]?.summary||'Source analysis is saved.')}</p><div class="source-row">${sourceLink(r.source_url)}<span class="muted small">Published ${when(r.published_at)}${r.pending_disclosures?` · ${r.pending_disclosures} other disclosures pending`:''}</span></div></article>`).join('')}</div></section>`;}
function digestsView(){const current=state.selectedDigest?.result||state.digest;
  const windows=[...new Set([6,12,24,36,48,72,168,state.settings?.digest_hours,state.window].filter(Number.isFinite))].sort((a,b)=>a-b);
  return heading('The important things, collected.','Every portfolio filing in your window. Prioritised, with routine updates kept out of the way.')+
    `<div class="content-grid"><div><section class="panel"><div class="panel-head"><div><h2>${state.selectedDigest?'Saved digest':'Portfolio digest'}</h2><p>${current?`${when(current.from,true)} — ${when(current.to,true)} IST`:'Loading the window…'}</p></div><label class="window-control" for="digest-window">Window<select id="digest-window">${windows.map(hours=>`<option value="${hours}" ${(state.window||state.settings?.digest_hours||24)===hours?'selected':''}>${hours} hours</option>`).join('')}</select></label></div>${state.selectedDigest?'<div class="panel-body"><button class="text-button" data-action="current-digest">← Back to current window</button></div>':''}${digestFeed(current)}</section>${savedContext()}
    <section class="panel"><div class="panel-head"><div><h2>Scheduled digests</h2><p>Saved after each configured digest window closes</p></div></div>${state.digests.length?`<div class="saved-digests">${state.digests.map(d=>`<div class="saved-digest"><div><strong>${when(d.window_start,true)} — ${when(d.window_end,true)}</strong><p>${number(d.result?.disclosure_count||0)} filings · saved ${when(d.created_at,true)} IST</p></div><button class="button secondary compact" data-action="saved-digest" data-id="${esc(d.id)}">Read digest ↗</button></div>`).join('')}</div>`:empty('Your first digest is on its way','You can use the current window above anytime. Scheduled digests are saved when their window closes.')}</section></div><aside class="watcher-aside">${watcherPanel()}</aside></div>`;
}
function alertsView(){return heading('A reason to pay attention.','Material announcements and unusual end-of-day moves, based on your own thresholds.',`<button class="button secondary" data-action="settings">Configure alerts</button>`)+
  `<div class="content-grid"><div>${state.alerts.length?state.alerts.map(a=>{const notification=state.notifications.find(n=>n.kind==='alert'&&n.reference_id===a.id);const details=a.trigger_details||{};return `<article class="alert-card"><div class="feed-meta"><strong>${esc(a.nse_symbol)}</strong><span>${when(a.created_at,true)} IST</span><span class="badge high">${details.metric?'Market activity':'Announcement'}</span>${notification&&!notification.read_at?'<span class="badge">Unread</span>':''}</div><h3>${esc(details.headline||a.message)}</h3>${details.headline?`<p>${esc(a.message)}</p>`:''}<p>${esc(details.why_it_matters||'A configured monitoring threshold was crossed.')}</p>${details.session?`<p class="small">Market session ${when(details.session)} · threshold ${number(details.threshold)}${details.metric==='close'?'%':'×'}</p>`:''}<div class="alert-footer"><div class="source-row">${sourceLink(details.source_url||details.evidence?.[0]?.source_url)}<button class="text-button" data-action="company" data-symbol="${esc(a.nse_symbol)}">Company details ↗</button></div>${notification&&!notification.read_at?`<button class="button secondary compact" data-action="read-notification" data-id="${esc(notification.id)}">Mark read</button>`:''}</div></article>`;}).join(''):`<section class="panel">${empty('No alerts yet','When an announcement is material or a completed session crosses your thresholds, it will appear here.')}</section>`}</div><aside class="watcher-aside">${watcherPanel()}</aside></div>`;}
function researchView(){const draft=state.draft;return heading('Go beyond the headline.','Ask about any NSE company. Read the fundamentals, with every conclusion tied to a primary source.')+
  `<div class="research-grid"><div class="research-left"><section class="panel"><div class="panel-head"><div><h2>Start a research brief</h2><p>Reports, earnings calls and primary disclosures</p></div><span aria-hidden="true">↗</span></div><div class="panel-body"><form id="research-form" class="research-form"><div><label for="research-symbol">Company ticker</label><input id="research-symbol" name="symbol" value="${esc(draft.symbol)}" placeholder="e.g. TCS" maxlength="40" autocomplete="off" autocapitalize="characters" required><p class="help">It doesn’t need to be in your watchlist.</p></div><div><label for="research-question">Optional focus or follow-up question</label><textarea id="research-question" name="question" maxlength="2000" placeholder="Leave blank for a broad company overview, or ask a specific follow-up.">${esc(draft.question)}</textarea><div class="presets"><button class="preset" type="button" data-action="preset" data-preset="business">Business overview</button><button class="preset" type="button" data-action="preset" data-preset="cash">Cash quality</button><button class="preset" type="button" data-action="preset" data-preset="guidance">Guidance vs. delivery</button></div></div><div><label for="source-policy">Research sources</label><select id="source-policy" name="source_policy"><option value="primary" ${draft.source_policy!=='assignment'?'selected':''}>Company primary disclosures</option><option value="assignment" ${draft.source_policy==='assignment'?'selected':''}>Annual reports + transcripts only</option></select><p class="help">Sources and reporting periods are selected as evidence is needed. A broad brief is saved first; additional documents can resolve important gaps.</p></div><button class="button primary" type="submit" ${state.starting?'disabled':''}>${state.starting?'<span class="spinner"></span> Queuing research…':'Research company <span aria-hidden="true">↗</span>'}</button></form></div></section>
  <section class="panel"><div class="panel-head"><h2>Research history</h2><span class="badge">${state.research.length}</span></div>${state.research.length?state.research.map(job=>`<button class="job-item ${job.id===state.selectedJob?'selected':''}" data-action="research-job" data-id="${esc(job.id)}"><span class="feed-meta"><strong>${esc(job.nse_symbol)}</strong>${researchBadge(job)}</span><span class="job-question">${esc(job.question)}</span><span class="cell-sub">${when(job.created_at,true)} IST</span></button>`).join(''):empty('Your research library','Completed and ongoing briefs will be saved here.')}</section></div><div id="research-output">${researchResult()}</div></div>`;}
function researchResult(){const job=state.job;
  if(!state.selectedJob)return `<section class="panel">${empty('A clearer view starts with a question.','Choose a company and ask about its growth, financial health, management guidance, or the case on either side.')}<div class="panel-body"><div class="side-rule"></div><p class="muted small">Primary company sources only. No broker notes, news summaries, or company facts from model memory.</p></div></section>`;
  if(!job)return `<section class="panel"><div class="page-loading"><span class="spinner"></span> Loading research…</div></section>`;
  const quotaPaused=job.error_kind==='quota_limit';
  const retryAt=job.research_state?.quota_retry_at;
  const quotaMessage=quotaPaused?(retryAt?`Model request limit reached. Please retry after ${when(retryAt,true)} IST. Your saved progress is retained.`:'Model request limit reached. Please retry when your quota becomes available. Your saved progress is retained.'):'';
  const unavailable=job.result?.report_type==='source_excerpts';
  const result=unavailable?null:job.result;
  const refining=!!result&&['running','waiting','queued'].includes(job.status);
  const focused=job.options?.mode==='focused'||(job.options?.mode!=='full'&&(job.research_state?.mode||result?.coverage));
  const docs=job.documents?.map(d=>({...d,selected_pages:job.research_state?.coverage?.find(c=>c.document_id===d.id)?.selected_pages}));
  const header=`<div class="report-header"><div class="feed-meta"><strong>${esc(job.nse_symbol)}</strong>${researchBadge(job)}<span>Started ${when(job.created_at,true)} IST</span></div><h2>${esc(result?.title||job.question)}</h2><p>${result?`${quotaPaused?'Saved brief · model request limit reached':refining?'Initial brief saved · additional evidence is being checked':'Completed '+when(job.completed_at,true)+' IST'} · ${job.data_as_of?.pages??'—'} pages read`:'Your question is being checked against the company’s primary documents.'}</p></div>`;
  if(result){return `<section class="panel">${header}<div class="report-body">${quotaPaused?`<p class="notice">${esc(quotaMessage)}</p><button class="button secondary" data-action="retry-research" data-id="${esc(job.id)}">Retry research</button>`:''}${job.status==='partial'?`<div class="notice">${['source_findings','source_excerpts'].includes(result.report_type)?'The model could not complete a validated brief. Saved source evidence is shown below.':'Some evidence could not be used. See the coverage limitations below.'}</div>`:''}
    ${refining?'<p class="notice">Your initial brief is ready. Targeted research continues in the background.</p>':''}
    ${result.adaptive?`<p class="help">${result.adaptive.passes} evidence pass(es) · ${result.adaptive.added_findings} additional findings · ${esc(human(result.adaptive.stop_reason))}</p>`:''}
    ${result.adaptive?.unresolved_questions?.length?`<details class="routine"><summary>Questions still needing evidence</summary><ul>${result.adaptive.unresolved_questions.map((g,index)=>`<li>${esc(g.question)} <button class="text-button" data-action="research-followup" data-index="${index}">Explore this question ↗</button></li>`).join('')}</ul></details>`:''}
    ${result.coverage?`<p class="help">Focused review · AI reviewed evidence from ${result.coverage.reviewed_pages??result.coverage.selected_pages} pages · ${result.coverage.indexed_pages} pages indexed · ${result.elapsed_seconds}s processing time</p>`:''}
    ${result.sections.map(section=>`<section class="report-section"><h3>${esc(topicLabels[section.topic]||human(section.topic))}${section.status==='unavailable'?' <span class="badge">Unavailable</span>':''}</h3>${section.status==='unavailable'?'<p class="muted">The supplied primary sources do not support this section.</p>':section.findings.map(f=>`<p>${esc(f.statement)} ${f.evidence_indexes.map(index=>`<button class="citation-button" data-action="research-evidence" data-index="${Number(index)}" aria-label="View source ${Number(index)+1}">[${Number(index)+1}]</button>`).join('')}</p>`).join('')}</section>`).join('')}
    ${result.missing_topics?.length?`<div class="notice neutral">Not covered: ${result.missing_topics.map(t=>esc(topicLabels[t]||human(t))).join(', ')}.</div>`:''}
    ${result.limitations?.length?`<section class="report-section"><h3>Coverage & limitations</h3><ul class="report-limitations">${result.limitations.map(l=>`<li>${esc(l)}</li>`).join('')}</ul></section>`:''}
    <details class="routine"><summary>Source documents & analysis details</summary>${sourceCoverage(job)}${documents(docs,focused)}<p class="help">Models: ${esc(result.models_used?.join(' · ')||'Not recorded')}<br>Sources collected ${when(job.data_as_of?.collected_at,true)} IST. Source publication periods may be earlier.</p></details></div></section>`;}
  const failed=job.status==='failed'||unavailable,retry=job.status==='waiting'&&job.next_attempt_at;
  const message=quotaPaused?quotaMessage:retry?`The backend will pick this up automatically on an available research turn after ${when(job.next_attempt_at,true)} IST. Keep the backend running. You can close this tab.`:
    failed?'Check the error details before retrying. Saved page reviews will be reused.':'All document text is indexed locally. The AI reviews selected evidence relevant to your question and saves a cited brief.';
  return `<section class="panel">${header}<div class="report-wait">${!failed&&!retry?'<div class="loading-line"><span class="spinner"></span> Background research in progress</div>':''}<h3>${esc(quotaPaused?'Model request limit reached':job.progress||'Waiting for source discovery')}</h3><p>${esc(message)}</p>
  ${(job.error||job.result?.processing_note)&&(failed||retry)?`<details class="routine"><summary>Error details</summary><p class="error-details">${esc(job.error||job.result?.processing_note)}</p></details>`:''}
  ${failed?`<button class="button secondary" data-action="retry-research" data-id="${esc(job.id)}">Retry research</button>`:''}
  ${sourceCoverage(job)}${documents(docs,focused)}${job.documents?.length?'':'<div class="skeleton-line"></div><div class="skeleton-line" style="width:60%"></div>'}<p class="help">Progress updates automatically. Reports only appear after validation.</p></div></section>`;
}
function sourceCoverage(job){
  const sources=job.sources||[];if(!sources.length)return '';
  const chosen=sources.filter(s=>s.download_status),deferred=sources.filter(s=>!s.download_status);
  return `<p class="help">${sources.length} source links discovered · ${chosen.length} documents selected · ${sources.filter(s=>s.download_status==='downloaded').length} downloaded. ${job.options?.source_policy==='assignment'?'Annual reports and transcripts only.':'Additional company disclosures may supplement annual reports and transcripts.'}</p>
    ${deferred.length?`<details class="routine"><summary>Other available sources (${deferred.length})</summary><p class="help">These links were discovered but have not been downloaded or reviewed. Further research may use them to answer unresolved questions.</p><ul>${deferred.map(s=>`<li>${sourceLink(s.source_url,s.title)}${s.metadata?.period_label?' · '+esc(s.metadata.period_label):''}</li>`).join('')}</ul></details>`:''}`;
}
function documents(docs=[],focused=false){
  return `<div style="margin-top:18px">${docs.map(d=>{
    const total=Number(d.total_pages??d.extraction_metadata?.totalPages)||0;
    const prepared=Number(d.prepared_pages??d.extraction_metadata?.pagesPrepared)||0;
    const progress=(label,count,denominator=total)=>`<p>${label} · ${number(count)} / ${number(denominator)} pages (${Math.floor(count/denominator*100)}%)</p><div class="progress-track" role="progressbar" aria-label="${label} for ${esc(d.title)}" aria-valuenow="${count}" aria-valuemin="0" aria-valuemax="${denominator}"><span style="width:${Math.min(100,count/denominator*100)}%"></span></div>`;
    return `<div class="document"><div class="document-head">${sourceLink(d.metadata?.primary_url||d.source_url,d.title+' ↗')}<span class="cell-sub">${esc(human(d.kind))}</span></div>
      ${d.metadata?.period_label||d.metadata?.published_at?`<p class="help">${esc(d.metadata.period_label||'Issuer disclosure')}${d.metadata?.published_at?' · Published '+when(d.metadata.published_at):''}</p>`:''}${d.metadata?.selection_reason?`<p class="help">${esc(d.metadata.selection_reason)}</p>`:''}
      ${total?progress(focused?'Text pages indexed':'PDF pages prepared',prepared):badge(d.status==='failed'?'failed':d.extraction_status||d.status)}
      ${total?(Number.isInteger(d.reviewed_pages)?(focused?(d.selected_pages?.length?progress('AI review saved for selected pages',Math.min(d.reviewed_pages,d.selected_pages.length),d.selected_pages.length):'<p class="help">Selecting evidence for your question…</p>'):progress('AI review saved',d.reviewed_pages)):'<p class="help">Restart the local backend to enable AI review counts for this job.</p>'):''}
      ${d.error?`<p class="negative">${esc(d.error)}</p>`:''}</div>`;
  }).join('')}</div>`;
}

function modal(title,content,footer=''){modalVersion++; $('#modal-body').innerHTML=`<div class="modal-header"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">×</button></div><div class="modal-content">${content}</div>${footer?`<div class="modal-footer">${footer}</div>`:''}`;if(!$('#modal').open)$('#modal').showModal();}
function openSettings(){const s=state.settings;if(!s)return toast('Settings have not loaded yet.',true);const r=type=>s.rules.find(r=>r.rule_type===type);const checked=value=>value?'checked':'';
  modal('Watcher settings',`<form id="settings-form"><div class="toggle-row"><label class="check"><input type="checkbox" name="monitoring_enabled" ${checked(s.monitoring_enabled)}> Enable routine monitoring</label></div><div class="settings-grid"><div><label for="monitor-minutes">Check interval · minutes</label><input id="monitor-minutes" type="number" name="monitoring_minutes" min="1" max="1440" required value="${s.monitoring_minutes}"></div><div><label for="digest-hours">Digest window · hours</label><input id="digest-hours" type="number" name="digest_hours" min="1" max="168" required value="${s.digest_hours}"></div></div>
    <div class="settings-section"><h3>Unusual market activity</h3><div class="settings-grid"><div><label class="check"><input type="checkbox" name="price_enabled" ${checked(r('price_move')?.enabled)}> Daily price alerts</label><label for="price-percent">Move beyond ± %</label><input id="price-percent" type="number" name="price_percent" min="0.01" step="any" max="1000" required value="${r('price_move')?.settings.percent??5}"></div><div><label class="check"><input type="checkbox" name="volume_enabled" ${checked(r('volume_spike')?.enabled)}> Volume alerts</label><label for="volume-multiple">Multiple of average</label><input id="volume-multiple" type="number" name="volume_multiple" min="0.01" step="any" max="1000" required value="${r('volume_spike')?.settings.multiple??2}"></div><div><label for="volume-sessions">Prior sessions for volume average</label><input id="volume-sessions" type="number" name="volume_sessions" min="2" max="250" required value="${r('volume_spike')?.settings.sessions??20}"></div></div><p class="help">These rules use completed daily sessions. Enough historical data is needed to calculate a baseline.</p></div>
    <div class="settings-section"><h3>Important announcements</h3><label class="check"><input type="checkbox" name="announcement_enabled" ${checked(r('announcement')?.enabled)}> Alert on material announcements in selected categories</label><div class="category-grid" style="margin-top:18px">${categories.map(c=>`<label class="check"><input type="checkbox" name="category" value="${esc(c)}" ${checked(r('announcement')?.settings.categories.includes(c))}> ${esc(human(c))}</label>`).join('')}</div></div><p class="help" style="margin-top:20px">Changing the digest window starts a new schedule. Already collected data is kept.</p><p id="settings-error" class="form-error" role="alert" hidden></p></form>`,
    '<button class="button secondary" data-action="close-modal">Cancel</button><button class="button primary" type="submit" form="settings-form">Save preferences</button>');
}
function evidenceDialog(evidence,title='Source evidence'){
  const rows=Array.isArray(evidence)?evidence:[evidence];
  modal(title,rows.length?rows.map(e=>`<section class="report-section"><div class="feed-meta"><span>${esc(e.source_title||'Primary source')}</span>${e.page||e.location?.page?`<span>Page ${number(e.page||e.location.page)}</span>`:''}<span>${esc(e.modality||e.evidence_snapshot?.modality||'text')} evidence</span></div><blockquote class="evidence-quote">${esc(e.quote||e.evidence_snapshot?.quote||'No quotation retained.')}</blockquote>${sourceLink(e.source_url,'Open original document ↗')}${e.id&&(e.has_image||e.modality==='visual')?`<details class="routine"><summary>View cited page image</summary><img class="evidence-image" loading="lazy" src="/api/app?resource=evidence&amp;id=${encodeURIComponent(e.id)}" alt="Cited page ${esc(e.page||e.location?.page||'')} from the source document"></details>`:''}</section>`).join(''):'<p class="muted">No retained evidence is available.</p>');
}
async function companyDialog(symbol){modal(symbol,'<div class="loading-line"><span class="spinner"></span> Loading company history…</div>');
  const version=modalVersion,company=await api('company',{params:{symbol}});if(!$('#modal').open||version!==modalVersion)return;
  const closes=company.observations.filter(o=>o.metric==='close'&&o.scope==='market'&&o.frequency==='daily').sort((a,b)=>+new Date(a.period_end)-+new Date(b.period_end));
  const current=state.portfolio.find(c=>c.nse_symbol===symbol)?.market;
  modal(symbol,`<div class="detail-stats">${stat('Latest EOD close',money(current?.close),current?when(current.session_date):'No saved session')}${stat('Daily change',percent(current?.change_percent),'Versus prior saved session')}${stat('Volume',compact(current?.volume),'Shares traded')}</div>
    <h3>Recent closing prices</h3>${closes.length>1?chart(closes):'<p class="muted">At least two completed sessions are needed to display a chart.</p>'}
    <p class="help">Saved daily closes, not live quotes. ${sourceLink(current?.source_url,'Price source ↗')}</p><div class="settings-section"><h3>Saved company developments</h3>${company.events.length?company.events.map(e=>`<article class="company-event"><div class="feed-meta">${badge(e.importance)}<span>${when(e.updated_at,true)} IST</span></div><h3>${esc(e.title)}</h3><p class="muted">${esc(e.summary)}</p><button class="text-button" data-action="company-evidence" data-event="${esc(e.id)}" data-symbol="${esc(symbol)}">Read source evidence ↗</button></article>`).join(''):'<p class="muted">No analysed developments saved yet.</p>'}</div>`,
    `<button class="button secondary" data-action="research-company" data-symbol="${esc(symbol)}">Research ${esc(symbol)} ↗</button><button class="button secondary" data-action="close-modal">Close</button>`);
}
function chart(rows){const values=rows.map(r=>Number(r.value)),low=Math.min(...values),high=Math.max(...values),range=high-low||1;
  const points=values.map((v,i)=>`${20+i/(values.length-1)*540},${150-(v-low)/range*125}`).join(' ');
  return `<svg class="chart" viewBox="0 0 580 180" role="img" aria-label="${rows.length} saved closing prices, from ${esc(money(values[0]))} to ${esc(money(values.at(-1)))}"><path d="M20 150H560M20 85H560M20 25H560" stroke="#edf0e6" fill="none"/><polygon points="20,160 ${points} 560,160" fill="#eef4e6"/><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><text x="20" y="15" fill="#99a58c" font-size="10">${esc(money(high))}</text><text x="20" y="178" fill="#99a58c" font-size="10">${esc(money(low))}</text></svg><div class="chart-label"><span>${when(rows[0].period_end)}</span><span>${when(rows.at(-1).period_end)}</span></div>`;
}
function statusDialog(){const s=state.status;if(!s)return toast('Processing status is unavailable.',true);
  modal('Backend activity',`<div class="notice neutral">The background runner works while your local server is open. Data-source or model outages can delay updates; progress is saved.</div><h3>Document processing</h3>${s.jobs?.length?`<div class="table-wrap"><table><thead><tr><th>STAGE</th><th>STATUS</th><th>JOBS</th></tr></thead><tbody>${s.jobs.map(j=>`<tr><td>${j.job_type==='extract'?'Prepare pages':'Analyse filings'}</td><td>${badge(j.status)}</td><td>${number(j.count)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No document jobs yet.</p>'}<div class="settings-section"><h3>Last background step</h3><p class="muted">${esc(human(s.monitor?.last_result?.phase||'Not started'))} · ${when(s.monitor?.last_finished_at,true)} IST</p>${s.monitor?.last_error?`<p class="error-details">${esc(s.monitor.last_error)}</p>`:''}</div>
  ${s.processingErrors?.length?`<div class="settings-section"><h3>Recent processing errors</h3>${s.processingErrors.map(e=>`<details class="routine"><summary>${esc(human(e.job_type))} · ${esc(human(e.error_kind||e.status))}${e.next_attempt_at?` · next retry ${when(e.next_attempt_at,true)} IST`:''}</summary><p class="error-details">${esc(e.error)}</p></details>`).join('')}</div>`:''}`);
}

$('#login-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;$('#auth-error').hidden=true;
  try{await api('session',{method:'POST',body:{access_code:$('#access-code').value}});$('#access-code').value='';await enterWorkspace();}
  catch(error){$('#auth-error').textContent=error.message;$('#auth-error').hidden=false;}finally{button.disabled=false;}});
$('#connection-retry').addEventListener('click',checkSession);
document.addEventListener('submit',async event=>{
  const form=event.target;if(!['add-company','research-form','settings-form'].includes(form.id))return;event.preventDefault();
  const data=new FormData(form),button=form.querySelector('[type="submit"]')||document.querySelector(`[form="${form.id}"]`);if(button)button.disabled=true;
  try{
    if(form.id==='add-company'){await api('portfolio',{method:'POST',body:{symbol:String(data.get('symbol')).trim()}});state.tickerDraft='';toast('Company added. Its first collection has been queued.');await load({force:true});}
    if(form.id==='research-form'){
      state.starting=true;const result=await api('research',{method:'POST',body:{symbol:String(data.get('symbol')).trim(),question:String(data.get('question')).trim(),source_policy:String(data.get('source_policy')||'primary')}});
      state.starting=false;toast('Research queued. Follow its progress here.');location.hash=`research/${result.id}`;readRoute();await load({force:true});
    }
    if(form.id==='settings-form'){
      const patch={};for(const name of ['monitoring_minutes','digest_hours','price_percent','volume_multiple','volume_sessions'])patch[name]=Number(data.get(name));
      for(const name of ['monitoring_enabled','price_enabled','volume_enabled','announcement_enabled'])patch[name]=data.has(name);
      patch.announcement_categories=data.getAll('category');await api('settings',{method:'PATCH',body:patch});$('#modal').close();toast('Watcher preferences saved.');await load({force:true});
    }
  }catch(error){if(form.id==='settings-form'){$('#settings-error').textContent=error.message;$('#settings-error').hidden=false;}else toast(error.message,true);}
  finally{state.starting=false;if(button?.isConnected)button.disabled=false;}
});
document.addEventListener('input',event=>{const e=event.target;if(e.id==='ticker')state.tickerDraft=e.value;if(e.closest('#research-form')&&e.name)state.draft[e.name]=e.value;});
document.addEventListener('change',async event=>{const e=event.target;if(e.closest('#research-form')&&e.name)state.draft[e.name]=e.value;if(e.id==='digest-window'){state.window=Number(e.value);state.selectedDigest=null;await load({force:true});}});
document.addEventListener('click',async event=>{
  if(event.target.closest('.skip-link')){event.preventDefault();$('#main').focus();return;}
  const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
  try{
    if(action==='close-modal'){$('#modal').close();return;}
    if(action==='settings'){openSettings();return;}
    if(action==='status'){statusDialog();return;}
    if(action==='company'){await companyDialog(button.dataset.symbol);return;}
    if(action==='research-followup'){
      const gap=state.job?.result?.adaptive?.unresolved_questions?.[Number(button.dataset.index)];
      if(gap){state.draft={symbol:state.job.nse_symbol,question:gap.question,source_policy:state.job.options?.source_policy||'primary'};paint(true);$('#research-question')?.focus();$('#research-form')?.scrollIntoView({block:'start',behavior:'smooth'});}
      return;
    }
    if(action==='research-company'){$('#modal').close();state.draft.symbol=button.dataset.symbol;location.hash='research';paint(true);return;}
    if(action==='research-job'){location.hash=`research/${button.dataset.id}`;return;}
    if(action==='preset'){const prompts={business:'Explain the business, its main segments, and what is driving growth. Ground the overview in the annual report and transcript.',cash:'Do the reported profits turn into cash? Explain cash from operations, debt, working capital, and any explicit concerns in the primary sources.',guidance:'What has management explicitly guided for growth, margins, or capital expenditure? Compare promises with reported outcomes where the selected sources support it, and identify missing periods.'};state.draft.question=prompts[button.dataset.preset];$('#research-question').value=state.draft.question;$('#research-question').focus();return;}
    if(action==='saved-digest'){state.selectedDigest=state.digests.find(d=>d.id===button.dataset.id);paint(true);return;}
    if(action==='current-digest'){state.selectedDigest=null;paint(true);return;}
    if(action==='research-evidence'){const index=Number(button.dataset.index);evidenceDialog((state.job?.result?.evidence||[]).filter(e=>e.fact_index===index),`Research source [${index+1}]`);return;}
    if(action==='digest-evidence'){const digest=state.selectedDigest?.result||state.digest,item=digest?.items.find(i=>i.id===button.dataset.disclosure),development=item?.developments?.[Number(button.dataset.index)];evidenceDialog(development?.evidence||[]);return;}
    if(action==='company-evidence'){const details=await api('company',{params:{symbol:button.dataset.symbol}});evidenceDialog(details.evidence.filter(e=>e.event_id===button.dataset.event).map(e=>({...e,...e.evidence_snapshot})));return;}
    if(action==='remove'){modal('Stop watching this company?',`<p>Remove <strong>${esc(button.dataset.symbol)}</strong> from your watchlist? Previously collected data and research will be kept.</p>`,`<button class="button secondary" data-action="close-modal">Keep watching</button><button class="button danger" data-action="confirm-remove" data-symbol="${esc(button.dataset.symbol)}">Stop watching</button>`);return;}
    button.disabled=true;
    if(action==='confirm-remove'){await api('portfolio',{method:'DELETE',body:{symbol:button.dataset.symbol}});$('#modal').close();toast('Company removed from the watchlist.');await load({force:true});}
    if(action==='logout'){await api('session',{method:'DELETE'});state.portfolio=null;state.job=null;state.draft={symbol:'',question:'',source_policy:'primary'};showLogin();}
    if(action==='refresh'){state.refreshing=true;await api('refresh',{method:'POST'});state.refreshing=false;toast('Refresh queued. Background progress will update automatically.');await load({force:true});}
    if(action==='toggle-monitor'){await api('settings',{method:'PATCH',body:{monitoring_enabled:!state.settings.monitoring_enabled}});toast(state.settings.monitoring_enabled?'Monitoring paused. Saved data is kept.':'Monitoring resumed.');await load({force:true});}
    if(action==='read-notification'){await api('notifications',{method:'PATCH',body:{id:button.dataset.id}});await load({force:true});}
    if(action==='retry-research'){await api('research-retry',{method:'POST',body:{id:button.dataset.id}});toast('Research requeued. Saved successful batches will be reused.');await load({force:true});}
  }catch(error){toast(error.message,true);}finally{state.refreshing=false;if(button.isConnected)button.disabled=false;}
});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const box=$('#modal').getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)$('#modal').close();}});
$('#modal').addEventListener('close',()=>{if(state.pendingPaint)paint();});
document.addEventListener('focusout',()=>{if(state.pendingPaint)setTimeout(()=>paint(),50);});
window.addEventListener('hashchange',async()=>{readRoute();paintChrome();paint(true);window.scrollTo(0,0);if(state.authenticated)await load({force:true});
  if(state.view==='research'&&state.selectedJob&&matchMedia('(max-width:950px)').matches)$('#research-output')?.scrollIntoView({block:'start'});
});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.authenticated)load();});
checkSession();

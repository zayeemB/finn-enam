import {load} from 'cheerio';
import {isIP} from 'node:net';
import {SourceClient,validateSourceUrl} from '../http.js';
import {fetchDisclosures} from '../sources.js';

const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export function sourceKind(title){
  if(/credit.rating|rating rationale|broker|research report/i.test(title))return null;
  if(/transcript/i.test(title))return 'transcript';
  if(/annual report/i.test(title))return 'annual_report';
  if(/presentation|investor.day|\bPPT\b/i.test(title))return 'presentation';
  if(/financial results|quarterly results|audited results|unaudited results/i.test(title))return 'quarterly_result';
  if(/shareholding|pledge|encumbrance/i.test(title))return 'ownership';
  if(/related.party|corporate.governance/i.test(title))return 'governance';
  if(/prospectus|offer document|\bDRHP\b|\bRHP\b/i.test(title))return 'offer_document';
  if(/acqui|merger|amalgamation|fund.rais|allotment|litigation|fraud|default|resign|management|director|order|contract|regulation 30|press release/i.test(title))return 'material_filing';
  return null;
}
export function primaryUrl(value,base,allowedHosts=[]){
  const u=new URL(value,base);
  const trusted=['bseindia.com','nseindia.com','nseindia.in',...allowedHosts].some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
  if(!trusted)throw new Error('Not an issuer or exchange source');
  if(u.hostname.endsWith('bseindia.com')&&/AnnPdfOpen\.aspx$/i.test(u.pathname)){
    const file=u.searchParams.get('Pname');
    if(!/^[a-z0-9-]+\.pdf$/i.test(file||''))throw new Error('Invalid BSE PDF link');
    return `https://www.bseindia.com/xml-data/corpfiling/AttachHis/${file}`;
  }
  return validateSourceUrl(u.href,allowedHosts);
}
function monthHint(label){
  const m=/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(20\d{2})/i.exec(label);
  return m?`${m[2]}-${String(months.findIndex(v=>v.toLowerCase()===m[1].toLowerCase())+1).padStart(2,'0')}-01`:null;
}
export function discoverLinks(html,name,discoveryUrl,{source_policy='primary',annual_reports,transcripts}={}){
  const $=load(html),identity=$('a').toArray().map(a=>$(a).text().replace(/\s/g,'').toUpperCase());
  if(!identity.includes(`NSE:${name}`))throw new Error('Research company identity could not be verified on Screener');
  const website=$('a').filter((_,a)=>$(a).text().trim()==='Website').first().attr('href'),extra=[];
  if(website){
    const u=new URL(website),host=u.hostname.replace(/^www\./,'');
    if(['https:','http:'].includes(u.protocol)&&!isIP(host)&&host.includes('.')&&!/\.(?:localhost|local|internal|test|invalid)$/.test(host))extra.push(host);
  }
  const catalogue=[],seen=new Set();
  const add=(kind,title,value,metadata={},resolver=false)=>{
    if(!kind||(source_policy==='assignment'&&!['annual_report','transcript'].includes(kind)))return;
    try{
      const url=resolver?validateSourceUrl(new URL(value,discoveryUrl).href):primaryUrl(value,discoveryUrl,extra);
      if(seen.has(url))return;seen.add(url);
      catalogue.push({kind,title:`${name} ${title}`.slice(0,240),source_url:url,discovery_url:discoveryUrl,
        metadata:{publisher:resolver?'Unresolved primary PDF':new URL(url).hostname,published_at:null,period_label:null,scope:'unknown',...metadata}});
    }catch{/* Untrusted links never enter the source catalogue. */}
  };
  for(const heading of ['Annual reports','Concalls','Announcements']){
    const h=$('h3').filter((_,e)=>$(e).text().trim()===heading).first();
    if(!h.length)continue;
    let section=h.parent();while(section.length&&!section.find('ul').length)section=section.parent();
    for(const a of section.find('ul a[href]').toArray()){
      const text=$(a).clone().children().remove().end().text().trim(),li=$(a).closest('li');
      if(heading==='Annual reports'&&/^Annual Report\s+\d{4}$/.test(text)){
        const year=Number(text.match(/\d{4}/)[0]);
        add('annual_report',text,$(a).attr('href'),{report_year:year,period_label:text,sort_date:`${year}-01-01`});
      }else if(heading==='Concalls'&&['Transcript','PPT'].includes(text)){
        const label=li.children('div').first().text().trim();
        add(text==='Transcript'?'transcript':'presentation',`${text==='Transcript'?'earnings-call transcript':'investor presentation'} ${label}`,$(a).attr('href'),
          {period_label:`Call ${label}`,call_month:monthHint(label),sort_date:monthHint(label)});
      }else if(heading==='Announcements'){
        const published=li.find('time[datetime]').attr('datetime');
        add(sourceKind(text),text,$(a).attr('href'),{published_at:published&&Number.isFinite(Date.parse(published))?new Date(published).toISOString():null,sort_date:published||null});
      }
    }
  }
  // Redirects to original filings, never Screener's calculated financial tables.
  const companyId=$('[data-company-id]').first().attr('data-company-id');
  for(const a of $('a[href*="/company/source/quarter/"]').toArray()){
    const match=/^\/company\/source\/quarter\/(\d+)\/(\d{1,2})\/(20\d{2})\/$/.exec($(a).attr('href'));
    if(!match||match[1]!==companyId||!['3','6','9','12'].includes(match[2]))continue;
    const end=new Date(Date.UTC(Number(match[3]),Number(match[2]),0)).toISOString().slice(0,10);
    add('quarterly_result',`quarterly results · ${end}`,$(a).attr('href'),{period_end:end,period_label:`Quarter ended ${end}`,sort_date:end,resolver:true},true);
  }
  // Legacy integrations can still request core counts; adaptive jobs use the catalogue.
  const documents=catalogue.filter(d=>['annual_report','transcript'].includes(d.kind)).filter((d,_,all)=>
    all.filter(x=>x.kind===d.kind).indexOf(d)<(d.kind==='annual_report'?annual_reports??1:transcripts??1));
  return {catalogue,documents,allowedHosts:extra,warnings:[]};
}
export function exchangeSources(rows,discoveryUrl,allowedHosts=[]){
  const result=[];
  for(const row of rows){
    const title=[row.title,row.rawMetadata?.attchmntText].filter(Boolean).join(' · '),kind=sourceKind(title);
    if(!kind||!row.assets?.length)continue;
    const published=row.publishedAt&&Number.isFinite(Date.parse(row.publishedAt))?new Date(row.publishedAt).toISOString():null;
    const monthFirst=/ended\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})/i.exec(title);
    const dayFirst=/ended\s+(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)[,]?\s+(20\d{2})/i.exec(title);
    const value=monthFirst?`${monthFirst[1]} ${monthFirst[2]}, ${monthFirst[3]}`:dayFirst?`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`:null;
    const period=value&&Number.isFinite(Date.parse(value+' UTC'))?new Date(value+' UTC').toISOString().slice(0,10):null;
    try{result.push({kind,title:title.slice(0,240),source_url:primaryUrl(row.assets[0].sourceUrl,discoveryUrl,allowedHosts),discovery_url:discoveryUrl,
      metadata:{publisher:'NSE issuer filing',published_at:published,sort_date:published,period_end:period,period_label:period?`Period ended ${period}`:null,scope:'unknown',exchange_key:row.sourceKey,revision_notice:/revised|corrigendum|correction/i.test(title)}});}catch{}
  }
  return result;
}
export async function discover(name,options={}, {deadline=Date.now()+45000,client=new SourceClient({deadline}),exchangeClient,now=new Date()}={}){
  const url=`https://www.screener.in/company/${encodeURIComponent(name)}/consolidated/`;
  let response;
  try{response=await client.get(url);}catch{response=await client.get(url.replace('/consolidated/','/'));}
  const found=discoverLinks(response.body.toString('utf8'),name,response.url,options);
  if(options.source_policy!=='assignment'&&Date.now()+2000<deadline){
    try{
      const rows=await fetchDisclosures(exchangeClient||new SourceClient({deadline:Math.min(deadline,Date.now()+12000)}),name,new Date(+now-90*86400000),now);
      const seen=new Set(found.catalogue.map(d=>d.source_url));
      for(const doc of exchangeSources(rows,'https://www.nseindia.com/companies-listing/corporate-filings-announcements',found.allowedHosts))if(!seen.has(doc.source_url)){found.catalogue.push(doc);seen.add(doc.source_url);}
    }catch{found.warnings.push('Recent NSE discovery was unavailable. Exchange filings linked from the company catalogue remain eligible; recent-event coverage may be incomplete.');}
  }
  return found;
}

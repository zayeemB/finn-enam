import {load} from 'cheerio';
import {isIP} from 'node:net';
import {SourceClient,validateSourceUrl} from '../http.js';

export function discoverLinks(html,name,discoveryUrl,{annual_reports=1,transcripts=1}={}) {
  const $=load(html),identity=$('a').toArray().map(a=>$(a).text().replace(/\s/g,'').toUpperCase());
  if(!identity.includes(`NSE:${name}`)) throw new Error('Research company identity could not be verified on Screener');
  const website=$('a').filter((_,a)=>$(a).text().trim()==='Website').first().attr('href');
  const extra=[];
  if(website) {
    const u=new URL(website);const host=u.hostname.replace(/^www\./,'');
    if(['https:','http:'].includes(u.protocol) && !isIP(host) && host.includes('.') && !/\.(?:localhost|local|internal|test|invalid)$/.test(host)) extra.push(host);
  }
  const documents=[],seen=new Set();
  for(const [heading,kind,limit] of [['Annual reports','annual_report',annual_reports],['Concalls','transcript',transcripts]]) {
    const h=$('h3').filter((_,e)=>$(e).text().trim()===heading).first();
    let section=h.parent();while(section.length && !section.find('ul').length)section=section.parent();
    for(const a of section.find('ul a[href]').toArray()) {
      const text=$(a).text().trim();
      if(kind==='transcript'?text!=='Transcript':!/^Annual Report\s+\d{4}$/.test(text)) continue;
      let url;
      try {
        const u=new URL($(a).attr('href'),discoveryUrl);
        const trusted=u.hostname==='bseindia.com'||u.hostname.endsWith('.bseindia.com')||u.hostname==='nseindia.com'||u.hostname.endsWith('.nseindia.com')||extra.some(h=>u.hostname===h||u.hostname.endsWith('.'+h));
        if(!trusted) continue;
        // BSE's AnnPdfOpen is an HTML wrapper; use its linked PDF identifier.
        if(u.hostname.endsWith('bseindia.com') && /AnnPdfOpen\.aspx$/i.test(u.pathname)) {
          const file=u.searchParams.get('Pname');if(!/^[a-z0-9-]+\.pdf$/i.test(file || ''))continue;
          url=`https://www.bseindia.com/xml-data/corpfiling/AttachHis/${file}`;
        }else url=u.href;
        validateSourceUrl(url,extra);
      }catch{continue;}
      if(seen.has(url))continue;seen.add(url);
      const label=kind==='annual_report'?text:$(a).closest('li').children('div').first().text().trim();
      documents.push({kind,title:`${name} ${kind==='annual_report'?text:`earnings-call transcript ${label}`}`.slice(0,240),source_url:url,discovery_url:discoveryUrl});
      if(documents.filter(d=>d.kind===kind).length>=limit)break;
    }
  }
  return {documents,allowedHosts:extra};
}
export async function discover(name,options,{deadline=Date.now()+45000,client=new SourceClient({deadline})}={}) {
  const url=`https://www.screener.in/company/${encodeURIComponent(name)}/consolidated/`;
  let response;
  try {response=await client.get(url);}catch {response=await client.get(url.replace('/consolidated/','/'));}
  return discoverLinks(response.body.toString('utf8'),name,response.url,options);
}

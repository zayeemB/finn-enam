import {hash} from '../sources.js';
import {passagesFor,selectPages,limits,OVERVIEW_QUESTION} from './brief.js';
import {evidenceRequirements} from './quality.js';
import {topics} from './schema.js';

export const passageKey=(page,text)=>hash([
  // Explicit dates in the passage survive deduplication. Undated passages retain document-period context.
  /(?:FY\s*|\b)20\d{2}\b/i.test(text)?'':page.document.metadata?.period_end||page.document.metadata?.period_label||page.asset?.content_hash||page.document.id,
  /consolidated/i.test(page.text)&&!/standalone/i.test(page.text)?'consolidated':
    /standalone/i.test(page.text)&&!/consolidated/i.test(page.text)?'standalone':
    page.document.metadata?.scope&&page.document.metadata.scope!=='unknown'?page.document.metadata.scope:
    'unknown:'+ (page.asset?.content_hash||page.document.id),
  text.replace(/\s+/g,' ').trim()].join('|'));
export function uniquePassages(pages,seen=[]){
  const used=new Set(seen);
  return pages.flatMap(page=>{
    if(page.text.trim().length<80)return [page];
    const excerpts=passagesFor(page,'').filter(p=>{
      const key=passageKey(page,p.text);if(used.has(key))return false;used.add(key);return true;
    }).map(p=>p.text);
    return excerpts.length?[{...page,excerpts}]:[];
  });
}
export function initialEvidence(pages,question){
  let visualSlots=limits.images;
  const selected=selectPages(pages,question,{strategy:'adaptive',profile:{pages:Infinity,characters:limits.characters,images:limits.images}});
  // Give actual cash-flow tables their period/header and operating/investing rows together.
  const cash=[...pages].sort((a,b)=>b.document.title.localeCompare(a.document.title)).find(p=>/cash\s+flows?\s+(?:from\s+)?operating\s+activities/i.test(p.text));
  if(cash){
    const chunks=cash.text.match(/[\s\S]{1,1000}/gu)||[],ids=new Set([0]);
    for(let i=0;i<chunks.length;i++)if(/net\s+cash|cash\s+generated|purchase.*(?:property|plant)|profit.*tax|working\s+capital/i.test(chunks[i])){ids.add(i);if(i>0)ids.add(i-1);}
    const excerpts=[...ids].sort((a,b)=>a-b).slice(0,6).map(i=>chunks[i]);
    const index=selected.findIndex(p=>p.id===cash.id);
    const item={...cash,excerpts,score:1000};
    if(index>=0)selected.splice(index,1);
    selected.unshift(item);
    while(selected.reduce((n,p)=>n+(p.excerpts?.join('').length??p.text.length),0)>limits.characters&&selected.length>1)selected.pop();
  }
  const profit=[...pages].sort((a,b)=>b.document.title.localeCompare(a.document.title)).find(p=>/profit for the year/i.test(p.text)&&/statement of profit|tax expense/i.test(p.text)&&!/changes in equity/i.test(p.text.slice(0,500)));
  if(profit&&!selected.some(p=>p.id===profit.id)){
    const chunks=profit.text.match(/[\s\S]{1,1000}/gu)||[];
    const matched=chunks.filter((t,i)=>i===0||/profit for the year|profit after tax|tax expense/i.test(t)).slice(0,3);
    const item={...profit,excerpts:matched,score:900};
    selected.splice(cash?1:0,0,item);
    while(selected.reduce((n,p)=>n+(p.excerpts?.join('').length??p.text.length),0)>limits.characters&&selected.length>2)selected.pop();
  }
  return uniquePassages(selected.filter(p=>p.text.trim().length>=80||visualSlots-->0));
}
export function evidenceGaps(checked,question){
  const text=topic=>checked.facts.filter(f=>f.topic===topic).map(f=>f.fact).join(' ');
  const required=evidenceRequirements.filter(r=>{
    const t=r.topic==='cash_quality'?text('cash_quality')+' '+text('financial_snapshot'):text(r.topic);
    if(r.topic==='cash_quality')return !/operating|cash from operat/i.test(t)||!/PAT|profit after tax|profit for the year/i.test(t)||!/capex|capital expenditure|plant|equipment/i.test(t)||!/working capital|receivables|inventories|payables/i.test(t);
    if(r.topic==='balance_sheet')return !t;
    return !t;
  });
  const requested=[...required.slice(0,1),...(checked.gaps || []),...required.slice(1)];
  const missing=question===OVERVIEW_QUESTION?topics.filter(t=>!checked.sections.some(s=>s.topic===t))
    .map(topic=>({topic,question:'Find primary evidence for '+topic.replaceAll('_',' ')})):[];
  return [...new Map([...requested,...missing].filter(g=>g&&typeof g.topic==='string').map(g=>({...g,question:typeof g.question==='string'&&g.question.trim()?g.question.trim():'Find supporting primary evidence for '+g.topic.replaceAll('_',' ')})).map(g=>[g.topic+' '+g.question.toLowerCase(),g])).values()].slice(0,4);
}
export function expansionEvidence(pages,gaps,seen){
  const stop=new Set('what which where find primary evidence full details provided information company financial statement'.split(' '));
  const used=new Set(seen),words=new Set(gaps.flatMap(g=>(g.question+' '+g.topic.replaceAll('_',' ')).toLowerCase().match(/[a-z]{4,}/g)||[]).filter(w=>!stop.has(w)));
  const scored=[];
  for(const page of pages){
    const chunks=passagesFor({...page,excerpts:undefined},'').filter(p=>!used.has(passageKey(page,p.text)));
    const ranked=chunks.map(p=>({...p,score:[...words].reduce((n,w)=>n+(p.text.toLowerCase().includes(w)?1:0),0)}))
      .filter(p=>p.score>=2).sort((a,b)=>b.score-a.score);
    if(ranked.length)scored.push({...page,excerpts:ranked.slice(0,3).map(p=>p.text),score:ranked[0].score});
  }
  scored.sort((a,b)=>b.score-a.score);
  if(gaps.some(g=>g.topic==='balance_sheet')){
    const finance=pages.find(p=>/retail.finance.arm|non.bank(?:ing)?.{0,12}financ|financ(?:ial|ing).{0,20}(?:segment|business|operations)/i.test(p.text));
    if(finance){
      const chunks=passagesFor({...finance,excerpts:undefined},'').filter(p=>!used.has(passageKey(finance,p.text))&&/financ|credit|NBFC/i.test(p.text)).slice(0,2);
      if(chunks.length)scored.unshift({...finance,excerpts:chunks.map(p=>p.text),score:1000});
    }
  }
  let characters=0;const selectedIds=new Set();
  return uniquePassages(scored.filter(page=>{
    if(selectedIds.has(page.id))return false;
    const count=page.excerpts.join('').length;
    if(characters+count>limits.characters)return false;
    characters+=count;selectedIds.add(page.id);return true;
  }),seen);
}
export function mergeBriefs(initial,extra){
  const facts=[...initial.facts],sections=initial.sections.map(s=>({...s,findings:[...s.findings]}));
  const seen=new Set(facts.map(f=>f.fact.toLowerCase().replace(/\W/g,'')));
  let added=0;
  for(const fact of extra.facts){
    const key=fact.fact.toLowerCase().replace(/\W/g,'');
    if(seen.has(key))continue;
    let section=sections.find(s=>s.topic===fact.topic);
    if(section?.findings.length>=4)continue;
    if(!section){section={topic:fact.topic,status:'available',findings:[]};sections.push(section);}
    const index=facts.length;facts.push(fact);section.findings.push({statement:fact.fact,evidence_indexes:[index]});
    seen.add(key);added++;
  }
  return {...initial,sections,facts,dropped:[...initial.dropped,...extra.dropped],
    limitations:extra.limitations,gaps:extra.gaps,added};
}

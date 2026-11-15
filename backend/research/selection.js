// Selection uses source metadata and indexed evidence. No model calls are spent on discovery.
const core=new Set(['annual_report','transcript']);
const date=d=>{
  const value=d.metadata?.sort_date||d.metadata?.period_end||d.metadata?.published_at||'';
  return value instanceof Date?value.toISOString():String(value);
};
export const newestFirst=docs=>[...docs].sort((a,b)=>date(b).localeCompare(date(a))||b.title.localeCompare(a.title));
const allowed=(d,policy)=>policy!=='assignment'||core.has(d.kind);
export function initialSources(catalogue,policy='primary'){
  const sorted=newestFirst(catalogue.filter(d=>allowed(d,policy))),chosen=[];
  for(const kind of ['annual_report','transcript','quarterly_result']){
    const doc=sorted.find(d=>d.kind===kind);if(doc)chosen.push({...doc,selection_reason:kind==='quarterly_result'?'Current reported figures':'Current foundation for the broad overview'});
  }
  // Missing core documents must not prevent a clearly labelled partial overview.
  if(!chosen.length&&sorted.length)chosen.push({...sorted[0],selection_reason:'Available primary source; core reports unavailable'});
  return chosen;
}
const key=d=>d.source_id||d.id||d.source_url;
function requestedQuarters(question){
  const m=/last\s+(four|three|two|[2-8])\s+quarters/i.exec(question);
  return m?({four:4,three:3,two:2}[m[1].toLowerCase()]||Number(m[1])):0;
}
function periodInFinancialEvidence(pages,pattern){
  return pages.some(p=>/financial results|statement of profit|financial highlights|revenue|cash flow/i.test(p.text)&&pattern.test(p.text)&&
    (p.text.match(/\b\d[\d,.]*\b/g)||[]).length>=4);
}
export function additionalSources(catalogue,documents,{question,gaps=[],pages=[],localQuestions=[],policy='primary'}={}){
  const selected=new Set(documents.map(key)),available=newestFirst(catalogue.filter(d=>allowed(d,policy)&&!selected.has(key(d))));
  const wanted=[],seen=new Set();
  const add=(doc,reason,priority)=>{if(doc&&!seen.has(key(doc))){seen.add(key(doc));wanted.push({...doc,selection_reason:reason,priority});}};
  const usable=documents.filter(d=>d.status!=='failed');
  // Recover a missing or inaccessible core source before attempting optional enrichment.
  for(const kind of core)if(!usable.some(d=>d.kind===kind))add(available.find(d=>d.kind===kind),'Replace an unavailable core source',110);
  const quarters=requestedQuarters((question||'')+' '+gaps.map(g=>g.question).join(' '));
  const resultPeriods=[...new Set(newestFirst(catalogue).filter(d=>d.kind==='quarterly_result'&&d.metadata?.period_end).map(d=>d.metadata.period_end))].slice(0,quarters);
  if(quarters){
    for(const period of resultPeriods){
      // A comparative table is sufficient only when the period is explicit in indexed primary text.
      const [y]=period.split('-'),label=new Date(`${period}T00:00:00Z`).toLocaleString('en-GB',{month:'short',timeZone:'UTC'});
      const covered=usable.some(d=>d.kind==='quarterly_result'&&d.metadata?.period_end===period)||periodInFinancialEvidence(pages,new RegExp(`(?:${label}\\w*[^\\n]{0,15}${y}|${period})`,'i'));
      if(!covered)add(available.find(d=>d.kind==='quarterly_result'&&d.metadata?.period_end===period),`Reported outcomes for quarter ended ${period}`,105);
    }
    const calls=newestFirst(catalogue.filter(d=>d.kind==='transcript'&&d.metadata?.call_month)).slice(0,quarters+1);
    for(const call of calls)if(!selected.has(key(call)))add(call,'Management commentary before and during the comparison window',90);
  }
  const years=[...new Set((question||'').match(/20\d{2}/g)||[])];
  const span=/last\s+(two|three|four|five|[2-9]|10)\s+years/i.exec(question||'');
  if(span){
    const n={two:2,three:3,four:4,five:5}[span[1].toLowerCase()]||Number(span[1]);
    const latest=Math.max(0,...catalogue.map(d=>d.metadata?.report_year||0));
    if(latest)for(let year=latest;year>latest-n;year--)if(!years.includes(String(year)))years.push(String(year));
  }
  for(const year of years)if(!periodInFinancialEvidence(pages,new RegExp(`\\b${year}\\b`)))add(available.find(d=>d.kind==='annual_report'&&d.metadata?.report_year===Number(year)),`Requested reporting year ${year}`,100);
  for(const gap of gaps){
    if(localQuestions.includes(gap.question))continue;
    const query=gap.topic+' '+gap.question;
    if(/cash|trajectory|multi.year|trend/i.test(query)){
      const relevant=pages.filter(p=>/cash flow|cash from operat|operating cash|financial highlights|revenue|profit after tax/i.test(p.text));
      const comparativeYears=new Set((relevant.map(p=>p.text).join(' ').match(/\b20\d{2}\b/g)||[]));
      if(comparativeYears.size<3)add(available.find(d=>d.kind==='annual_report'),'Earlier financial and cash-flow comparisons missing from indexed evidence',70);
    }
    if(/guidance|narrative|promis|outcome/i.test(query)){
      add(available.find(d=>d.kind==='quarterly_result'),'Reported outcomes to check against management commentary',100);
      add(available.find(d=>d.kind==='presentation'),'Operating measures and explicitly stated management targets',80);
      add(available.find(d=>d.kind==='transcript'),'Earlier management expectations for comparison with outcomes',75);
    }
    if(/business|segment|capacity/i.test(query))add(available.find(d=>d.kind==='presentation'),'Business segments, capacity or operating measures not yet established',80);
    for(const [kind,pattern] of [['ownership',/sharehold|pledge|promoter|ownership/i],['governance',/governance|related.party|auditor|board oversight/i],['offer_document',/prospectus|IPO|proceeds|concentration|offer document/i]]){
      if(pattern.test(query))add(available.find(d=>d.kind===kind),`Primary disclosure for: ${gap.question}`,85);
    }
  }
  // New events can post-date the latest call. Catalogue headlines are routing hints, never findings.
  const latestCore=newestFirst(usable.filter(d=>core.has(d.kind)))[0];
  const filing=available.find(d=>d.kind==='material_filing'&&d.metadata?.published_at&&(!date(latestCore||{})||date(d)>date(latestCore)));
  const eventPattern=/recent|developments|acqui|merger|litigation|management change|fund.rais|major contract/i;
  const eventGap=gaps.some(g=>eventPattern.test(g.question)&&!localQuestions.includes(g.question));
  if(filing&&(eventGap||!usable.some(d=>d.kind==='material_filing')&&(gaps.length||eventPattern.test(question||''))))add(filing,'Material development after the core reporting sources',60);
  return wanted.sort((a,b)=>b.priority-a.priority||date(b).localeCompare(date(a)));
}

import {hash} from '../sources.js';
import {passagesFor,selectPages,limits,OVERVIEW_QUESTION} from './brief.js';
import {topics} from './schema.js';

export const passageKey=(page,text)=>hash([page.asset?.content_hash||page.document.id,page.sequence,text].join('|'));
export function initialEvidence(pages,question){
  let visualSlots=limits.images;
  return selectPages(pages,question,{strategy:'adaptive',profile:{pages:Infinity,characters:limits.characters,images:limits.images}})
    .filter(p=>p.text.trim().length>=80||visualSlots-->0);
}
export function evidenceGaps(checked,question){
  const requested=checked.gaps || [];
  const missing=question===OVERVIEW_QUESTION?topics.filter(t=>!checked.sections.some(s=>s.topic===t))
    .map(topic=>({topic,question:'Find primary evidence for '+topic.replaceAll('_',' ')})):[];
  return [...new Map([...requested,...missing].map(g=>[g.topic+' '+g.question.toLowerCase(),g])).values()].slice(0,4);
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
  let characters=0;
  return scored.filter(page=>{
    const count=page.excerpts.join('').length;
    if(characters+count>limits.characters)return false;
    characters+=count;return true;
  });
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

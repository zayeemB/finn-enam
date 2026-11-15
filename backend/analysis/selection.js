import {selectPages} from '../research/brief.js';
export const MONITOR_CHARACTERS=18000;
export function monitoringEvidence(blocks,title){
 const total=blocks.reduce((n,b)=>n+(b.content.text||'').length,0);
 if(blocks.length<=8&&total<=MONITOR_CHARACTERS)return {blocks,focused:false,total:blocks.length};
 const pages=blocks.map(b=>({...b,text:b.content.text||'',document:{id:b.asset_id,title:b.asset?.filename||title}}));
 let visual=1;
 const selected=selectPages(pages,title+' financial results revenue PAT cash flow outlook management change resignation acquisition litigation fraud penalty fundraising',{strategy:'adaptive',profile:{pages:Infinity,characters:MONITOR_CHARACTERS,images:1}})
  .filter(p=>p.text.trim().length>=80||visual-->0).map(p=>({...p,promptText:p.excerpts?.join('\n')||p.text}));
 return {blocks:selected,focused:true,total:blocks.length};
}

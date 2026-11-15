import {z} from 'zod';
export const observationSchema=z.object({metric:z.enum(['revenue','pat','net_operating_cash','capex','operating_margin','segment_revenue','geographic_revenue']),label:z.string().max(100),value:z.number().finite(),unit:z.enum(['INR crore','INR million','USD million','percent']),scope:z.enum(['consolidated','standalone']),period_start:z.iso.date(),period_end:z.iso.date(),source_id:z.string(),quote:z.string().min(10).max(1400)}).strict();
// Conservative exhibit admission: one exact quoted passage must contain the
// number, metric, units, scope and BOTH dates. Unresolved table headers are not chart data.
const metricWords={revenue:/revenue|sales/i,pat:/profit after tax|profit for the (?:year|period)|PAT/i,net_operating_cash:/net cash.*operating|net operating cash/i,capex:/capital expenditure|purchase.*(?:plant|equipment|property)/i,operating_margin:/operating margin|EBITDA margin/i,segment_revenue:/segment.*revenue|revenue.*segment/i,geographic_revenue:/geograph|revenue.*region/i};
const datePresent=(quote,value)=>{const d=new Date(value+'T00:00:00Z'),month=d.toLocaleString('en-US',{month:'long',timeZone:'UTC'}),short=month.slice(0,3),day=d.getUTCDate(),year=d.getUTCFullYear();return quote.includes(value)||new RegExp(`(?:${day}(?:st|nd|rd|th)?[ ,/-]+(?:${month}|${short})[ ,/-]+${year}|(?:${month}|${short})[ ,/-]+${day}(?:st|nd|rd|th)?[ ,/-]+${year})`,'i').test(quote);};
export function validateObservations(values,sources){
 const accepted=[],excluded=[];
 for(const input of values||[]){try{
  const v=observationSchema.parse(input),source=sources.get(v.source_id),q=v.quote;
  if(!source||source.visual||!source.text.includes(q))throw Error('Exact text quotation unavailable');
  const nums=(q.match(/-?\d[\d,]*(?:\.\d+)?/g)||[]).map(n=>Number(n.replaceAll(',','')));
  if(!nums.includes(v.value)||!metricWords[v.metric].test(q)||!q.toLowerCase().includes(v.scope)||!datePresent(q,v.period_start)||!datePresent(q,v.period_end)||v.period_start>=v.period_end)throw Error('Metric, period or scope not established in the quotation');
  const units=v.unit==='percent'?/%|percent/i:v.unit==='INR crore'?/(?:INR|Rs\.?|₹).*crore/i:v.unit==='INR million'?/(?:INR|Rs\.?|₹).*million/i:/USD.*million/i;
  if(!units.test(q))throw Error('Unit not established');
  if(['segment_revenue','geographic_revenue'].includes(v.metric)&&!q.toLowerCase().includes(v.label.toLowerCase()))throw Error('Revenue category not established');
  if(v.scope==='consolidated'&&/standalone/i.test(q)||v.scope==='standalone'&&/consolidated/i.test(q))throw Error('Ambiguous scope');
  accepted.push({...v,block_id:source.page.id,source_url:source.page.document.source_url,page:source.page.sequence,source_title:source.page.document.title,published_at:source.page.document.metadata?.published_at});
 }catch(error){excluded.push({metric:input.metric,reason:error.message});}}
 return {accepted,excluded};
}
const compatible=(a,b)=>a.scope===b.scope&&a.unit===b.unit&&Math.abs((Date.parse(a.period_end)-Date.parse(a.period_start))-(Date.parse(b.period_end)-Date.parse(b.period_start)))<=86400000*2;
export function buildExhibits(observations=[],commitments=[]){
 const unique=new Map();const conflicts=new Set();
 for(const o of observations){const key=[o.metric,o.label,o.scope,o.unit,o.period_start,o.period_end].join('|');if(unique.has(key)&&unique.get(key).value!==o.value)conflicts.add(key);else unique.set(key,o);}
 const valid=[...unique].filter(([k])=>!conflicts.has(k)).map(([,v])=>v),comparisons=[];
 for(const metric of ['revenue','pat','operating_margin']){
  const rows=valid.filter(o=>o.metric===metric).sort((a,b)=>a.period_end.localeCompare(b.period_end));
  for(let i=1;i<rows.length;i++){const a=rows[i-1],b=rows[i];if(!compatible(a,b)||a.period_end>=b.period_start||a.value<=0)continue;comparisons.push({metric,prior:a,current:b,change:metric==='operating_margin'?b.value-a.value:(b.value/a.value-1)*100,method:metric==='operating_margin'?'current − prior (percentage points)':'(current / prior − 1) × 100'});}
 }
 const cash=valid.filter(o=>o.metric==='pat').flatMap(p=>valid.filter(c=>c.metric==='net_operating_cash'&&compatible(p,c)&&p.period_start===c.period_start&&p.period_end===c.period_end).map(c=>({profit:p,cash:c,conversion:p.value>0?c.value/p.value:null,method:'Net cash from operating activities / profit after tax'})));
 const divergence=[];for(const revenue of comparisons.filter(c=>c.metric==='revenue')){const profit=comparisons.find(c=>c.metric==='pat'&&compatible(c.current,revenue.current)&&c.current.period_start===revenue.current.period_start&&c.current.period_end===revenue.current.period_end&&c.prior.period_start===revenue.prior.period_start&&c.prior.period_end===revenue.prior.period_end);if(profit)divergence.push({revenue,profit});}
 const delivery=commitments.map(target=>({target,outcome:valid.find(o=>o.metric===target.metric&&o.scope===target.scope&&o.unit===target.unit&&o.period_start===target.period_start&&o.period_end===target.period_end&&Date.parse(o.published_at||o.period_end)>=Date.parse(target.period_end))||null}));
 return {observations:valid,comparisons,cash,delivery,divergence,conflicts:conflicts.size};
}

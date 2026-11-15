import {symbol,fetchPrices} from '../sources.js';
import {SourceClient} from '../http.js';
// Process-local cache is shared by authenticated requests, not by portfolio membership.
export function marketContext({clock=()=>new Date(),fetchSeries=fetchPrices,clientFactory=opts=>new SourceClient(opts)}={}){
 const cache=new Map();
 return async name=>{
  name=symbol(name);const now=clock(),prior=cache.get(name);
  if(prior&&+now-prior.at<300000)return prior.promise;
  const entry={at:+now};
  entry.promise=(async()=>{
   try{
    const data=await fetchSeries(clientFactory({deadline:Date.now()+12000}),name,new Date(+now-400*86400000),now);
    const rows=[...new Map(data.rows.map(r=>[r.day,r])).values()].sort((a,b)=>a.day.localeCompare(b.day));
    const value={symbol:name,kind:'completed_eod',currency:'INR',source_url:data.url,fetched_at:now,rows,corporate_actions:data.corporateActions||{}};
    entry.value=value;return value;
   }catch(error){
    if(prior?.value){entry.value=prior.value;return {...prior.value,stale:true,warning:'Refresh failed; showing previously fetched completed sessions.'};}
    cache.delete(name);throw Object.assign(new Error('Market history is temporarily unavailable. Research remains available.'),{status:503});
   }
  })();
  if(cache.size>=100&&!cache.has(name))cache.delete(cache.keys().next().value);
  cache.set(name,entry);return entry.promise;
 };
}

import {test} from 'node:test';import assert from 'node:assert/strict';
import {marketContext} from '../research/market.js';
test('market requests share bounded cached fetches without model or portfolio access',async()=>{
 let calls=0,now=new Date('2026-11-15T12:00:00Z');
 const get=marketContext({clock:()=>now,fetchSeries:async(_client,name,start,end)=>{calls++;assert.equal(name,'TCS');assert.equal(+end-+start,400*86400000);return {rows:[{day:'2026-11-13',values:{close:100,volume:10}}],url:'https://query2.finance.yahoo.com/test'};}});
 const [a,b]=await Promise.all([get('tcs.ns'),get('TCS')]);assert.equal(calls,1);assert.equal(a,b);assert.equal(a.kind,'completed_eod');
 now=new Date(+now+300001);await get('TCS');assert.equal(calls,2);
});
test('refresh failures retain clearly marked cached history',async()=>{
 let now=new Date(),fail=false;
 const get=marketContext({clock:()=>now,fetchSeries:async()=>{if(fail)throw Error('Unavailable');return {rows:[{day:'2026-11-13',values:{close:100,volume:10}}],url:'https://query2.finance.yahoo.com/test'};}});
 await get('TEST');fail=true;now=new Date(+now+300001);assert.equal((await get('TEST')).stale,true);
 const unavailable=marketContext({fetchSeries:async()=>{throw Error('Unavailable');}});await assert.rejects(()=>unavailable('TEST'),e=>e.status===503);
});

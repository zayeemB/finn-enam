import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateObservations,buildExhibits} from '../research/exhibits.js';
const o=(metric,value,year)=>({metric,label:metric,value,unit:'INR crore',scope:'consolidated',period_start:year+'-04-01',period_end:(year+1)+'-03-31',source_id:'p1.1',quote:`Consolidated revenue INR crore ${value} from April 1, ${year} to March 31, ${year+1}.`});
test('exhibits reject missing period/unit/scope support and unsupported values',()=>{
 const v=o('revenue',120,2025),sources=new Map([['p1.1',{text:v.quote,page:{id:'page',sequence:1,document:{title:'Fixture',source_url:'https://example.com'}}}]]);
 assert.equal(validateObservations([v],sources).accepted.length,1);
 for(const change of [{value:999},{scope:'standalone'},{unit:'USD million'},{period_start:'2025-01-01'}])assert.equal(validateObservations([{...v,...change}],sources).accepted.length,0);
});
test('computed comparisons retain inputs and refuse incompatible cash periods and conflicting values',()=>{
 const a=o('revenue',100,2024),b=o('revenue',120,2025),p=o('pat',20,2025),c=o('net_operating_cash',30,2025);
 const x=buildExhibits([a,b,p,c]);assert.ok(Math.abs(x.comparisons[0].change-20)<1e-8);assert.equal(x.cash[0].conversion,1.5);
 assert.equal(buildExhibits([p,{...c,scope:'standalone'}]).cash.length,0);
 assert.equal(buildExhibits([a,{...a,value:999},b]).comparisons.length,0);
 assert.equal(buildExhibits([a,{...b,unit:'USD million'}]).comparisons.length,0);
});

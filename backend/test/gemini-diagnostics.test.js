import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseGemini} from '../diagnostics/gemini.js';
import {GeminiClient,providerError} from '../analysis/gemini.js';

test('minimal diagnostics distinguish valid credentials from an overloaded model',async()=>{
  const requests=[];
  const result=await diagnoseGemini({apiKey:'secret-value',compareEndpoints:true,fetchImpl:async(url,request)=>{
    requests.push({url,request});
    if(request.method==='GET') return Response.json({name:'models/gemini-3.8-flash'});
    const body=JSON.parse(request.body);
    assert.ok(request.body.includes('single word OK'));
    assert.ok(!request.body.includes('secret-value'));
    assert.ok(!body.system_instruction);
    return Response.json({error:{code:503,status:'UNAVAILABLE',message:'This model is currently experiencing high demand.'}},{status:503});
  }});
  assert.equal(result.key_has_model_access,true);
  assert.equal(result.status,'model_overloaded');
  assert.equal(requests.length,3);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});

test('failed authentication stops diagnostic generation requests',async()=>{
  let calls=0;
  const result=await diagnoseGemini({apiKey:'secret-value',fetchImpl:async()=>{
    calls++;return Response.json({error:{code:403,message:'Key secret-value denied'}},{status:403});
  }});
  assert.equal(calls,1);
  assert.equal(result.status,'authentication_or_access_error');
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});

test('provider errors preserve useful reasons while redacting keys and respecting retry timing',async()=>{
  const error=await providerError(Response.json({error:{code:'service_unavailable',message:'High demand; key secret-value'}},
    {status:503,headers:{'retry-after':'90'}}),'secret-value');
  assert.equal(error.retryable,true);
  assert.equal(error.providerCode,'service_unavailable');
  assert.equal(error.retryAfterMs,90000);
  assert.match(error.message,/High demand/);
  assert.ok(!error.message.includes('secret-value'));
  const invalid=await providerError(Response.json({error:{message:'Invalid request'}},{status:400}),'secret-value');
  assert.equal(invalid.retryable,false);
});

test('timeouts and network failures become actionable transient errors',async()=>{
  const timeout=new GeminiClient({apiKey:'secret-value',fetchImpl:async()=>{throw new DOMException('Timed out','TimeoutError');}});
  await assert.rejects(()=>timeout.generate({stage:'test',prompt:'synthetic',timeoutMs:2000}),
    error=>error.retryable && error.status===408 && /2 seconds/.test(error.message));
  const network=new GeminiClient({apiKey:'secret-value',fetchImpl:async()=>{throw new TypeError('fetch failed');}});
  await assert.rejects(()=>network.generate({stage:'test',prompt:'synthetic'}),error=>error.retryable && /network/.test(error.message));
});

test('optional thinking level is explicit and invalid values are rejected',async()=>{
  const client=new GeminiClient({apiKey:'secret-value',thinkingLevel:'low',fetchImpl:async(_url,request)=>{
    assert.equal(JSON.parse(request.body).generation_config.thinking_level,'low');
    return Response.json({status:'completed',output_text:'{}'});
  }});
  await client.generate({stage:'test',prompt:'synthetic'});
  assert.throws(()=>new GeminiClient({apiKey:'secret-value',thinkingLevel:'minimal'}),/thinking/i);
});

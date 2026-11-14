import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GroqClient} from '../analysis/groq.js';
import {diagnoseGroq} from '../diagnostics/groq.js';

const result={covered_block_ids:[],developments:[],limitations:[]};
const completion=(data=result,finish_reason='stop')=>Response.json({choices:[{finish_reason,message:{content:JSON.stringify(data)}}],usage:{prompt_tokens:10,completion_tokens:10}});

test('Groq adapter sends complete page text and labelled images to the fixed endpoint',async()=>{
  const client=new GroqClient({apiKey:'gsk_secret',fetchImpl:async(url,request)=>{
    assert.equal(url,'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(request.headers.Authorization,'Bearer gsk_secret');assert.equal(request.redirect,'error');
    const body=JSON.parse(request.body);
    assert.equal(body.model,'qwen/qwen3.8-27b');assert.equal(body.response_format.type,'json_object');
    assert.ok(!body.tools);assert.ok(!request.body.includes('gsk_secret'));
    assert.match(body.messages[0].content,/UNTRUSTED DATA/);
    const content=body.messages[1].content;
    assert.match(content[0].text,/all the page text/);assert.match(content[1].text,/block page-1/);
    assert.equal(content[2].image_url.url,'data:image/png;base64,cGFnZQ==');
    return completion();
  }});
  const output=await client.generate({stage:'page_extraction',prompt:'all the page text',images:[{blockId:'page-1',mimeType:'image/png',bytes:Buffer.from('page')}]});
  assert.deepEqual(output.data,result);assert.equal(output.provider,'groq');assert.equal(output.model,'qwen/qwen3.8-27b');
});

test('Groq does not accept truncated output, invalid JSON or text-only model substitutions',async()=>{
  assert.throws(()=>new GroqClient({apiKey:'key',model:'openai/gpt-oss-120b'}),/vision model/);
  const limited=new GroqClient({apiKey:'key',fetchImpl:async()=>completion(result,'length')});
  await assert.rejects(()=>limited.generate({stage:'test',prompt:'test'}),/did not complete/);
  const invalid=new GroqClient({apiKey:'key',fetchImpl:async()=>Response.json({choices:[{finish_reason:'stop',message:{content:'bad json'}}]})});
  await assert.rejects(()=>invalid.generate({stage:'test',prompt:'test'}),/invalid structured JSON/);
  await assert.rejects(()=>limited.generate({stage:'test',prompt:'test',images:Array(4).fill({})}),/three page images/);
});

test('Groq quota reasons are redacted and respect Retry-After; timeouts remain retryable',async()=>{
  const client=new GroqClient({apiKey:'gsk_secret',fetchImpl:async()=>Response.json({error:{code:'rate_limit_exceeded',message:'Limit exceeded for gsk_secret'}},{status:429,headers:{'retry-after':'120'}})});
  await assert.rejects(()=>client.generate({stage:'test',prompt:'test'}),error=>{
    assert.equal(error.status,429);assert.equal(error.retryable,true);assert.equal(error.retryAfterMs,120000);
    assert.match(error.message,/Groq/);assert.ok(!error.message.includes('gsk_secret'));return true;
  });
  const timeout=new GroqClient({apiKey:'key',fetchImpl:async()=>{throw new DOMException('Timeout','TimeoutError');}});
  await assert.rejects(()=>timeout.generate({stage:'test',prompt:'test'}),error=>error.status===408 && error.retryable);
});

test('a request larger than the entire Groq token quota needs configuration changes instead of repeated retries',async()=>{
  const client=new GroqClient({apiKey:'key',fetchImpl:async()=>Response.json({error:{message:'Request too large on output tokens per minute: Limit 1000, Requested 1597'}},{status:429})});
  await assert.rejects(()=>client.generate({stage:'test',prompt:'test'}),error=>error.configuration && !error.retryable);
});

test('Groq diagnostic makes no request without a key and otherwise checks synthetic structured output',async()=>{
  const missing=await diagnoseGroq({apiKey:'',fetchImpl:async()=>{throw new Error('must not fetch');}});
  assert.equal(missing.status,'missing_key');
  const valid=await diagnoseGroq({apiKey:'gsk_secret',fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body);
    assert.equal(body.max_completion_tokens,256);
    assert.match(body.messages[1].content[0].text,/Synthetic connectivity test/);
    assert.equal(body.messages[1].content.length,1);
    return completion();
  }});
  assert.equal(valid.status,'minimal_request_succeeded');assert.ok(!JSON.stringify(valid).includes('gsk_secret'));
});

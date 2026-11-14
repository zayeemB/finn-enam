import {RESPONSE_SCHEMA,SYSTEM} from './schema.js';
import {ModelError,providerError} from './gemini.js';

export class GroqClient {
  provider='groq';
  maxImages=3;
  preferredBatchSize=1; // Leave more room for full page text under the free-plan token rate limit.
  constructor({apiKey=process.env.GROQ_API_KEY,model=process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    maxOutputTokens=Number(process.env.GROQ_MAX_OUTPUT_TOKENS || 900),fetchImpl=fetch}={}) {
    if (!apiKey) throw new Error('Set GROQ_API_KEY in the ignored .env or server secrets; do not paste it into chat');
    // Only this vision-capable model has been integrated; no text-only substitute.
    if (model!=='qwen/qwen3.8-27b') throw new Error('GROQ_MODEL must be the supported vision model qwen/qwen3.8-27b');
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens<256 || maxOutputTokens>16000) throw new Error('GROQ_MAX_OUTPUT_TOKENS must be an integer between 256 and 16000');
    Object.assign(this,{apiKey,model,maxOutputTokens,fetchImpl});
  }
  async generate({stage,prompt,images=[],timeoutMs=300000,systemInstruction=SYSTEM,responseSchema=RESPONSE_SCHEMA}) {
    if (images.length>this.maxImages) throw new ModelError('Groq accepts at most three page images per request; lower ANALYSIS_PAGES_PER_BATCH');
    const content=[{type:'text',text:`Stage: ${stage}\n${prompt}`}];
    for (const image of images) {
      if (!['image/png','image/jpeg'].includes(image.mimeType)) throw new ModelError('Unsupported Groq page image type');
      content.push({type:'text',text:`Page image for block ${image.blockId}`},
        {type:'image_url',image_url:{url:`data:${image.mimeType};base64,${image.bytes.toString('base64')}`}});
    }
    const payload={model:this.model,stream:false,max_completion_tokens:this.maxOutputTokens,
      response_format:{type:'json_object'},messages:[{role:'system',content:`${systemInstruction}\nReturn only a JSON object matching this schema.\n${JSON.stringify(responseSchema)}`},
        {role:'user',content}]};
    const body=JSON.stringify(payload);
    if (Buffer.byteLength(body)>19*1024*1024) throw new ModelError('Groq request exceeds safe inline size; lower ANALYSIS_PAGES_PER_BATCH');
    let response;
    try {
      response=await this.fetchImpl('https://api.groq.com/openai/v1/chat/completions',{
        method:'POST',redirect:'error',signal:AbortSignal.timeout(Math.max(1,timeoutMs)),
        headers:{Authorization:`Bearer ${this.apiKey}`,'Content-Type':'application/json'},body});
    }catch(error) {
      if (['AbortError','TimeoutError'].includes(error.name)) throw new ModelError(`Groq request timed out after ${Math.ceil(timeoutMs/1000)} seconds`,{status:408});
      throw new ModelError('Groq network request failed',{retryable:true});
    }
    if (!response.ok) {
      const error=await providerError(response,this.apiKey,Date.now(),'Groq');
      // Waiting cannot fix a request whose size exceeds the whole minute's quota.
      if (response.status===429 && /request too large/i.test(error.message)) {
        error.retryable=false;error.configuration=true;
      }
      throw error;
    }
    let result;
    try {result=await response.json();}
    catch(error) {
      if (['AbortError','TimeoutError'].includes(error.name)) throw new ModelError('Groq response timed out',{status:408});
      throw new ModelError('Groq returned a non-JSON API response',{retryable:true});
    }
    const choice=result.choices?.[0];
    if (choice?.finish_reason!=='stop') throw new ModelError(`Groq response did not complete (${choice?.finish_reason || 'missing choice'})`);
    let data;
    try {data=JSON.parse(choice.message.content);}catch {throw new ModelError('Groq returned invalid structured JSON');}
    return {data,usage:result.usage || null,model:this.model,provider:this.provider};
  }
}

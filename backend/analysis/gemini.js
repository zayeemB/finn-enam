import {createHash} from 'node:crypto';
import { RESPONSE_SCHEMA, SYSTEM } from './schema.js';

export class ModelError extends Error {
  constructor(message, { status, retryAfterMs = 60000, providerCode, retryable = [408,429,500,502,503,504].includes(status) } = {}) {
    super(message); Object.assign(this, { status, retryAfterMs, providerCode, retryable });
  }
}

export function safeProviderMessage(value, apiKey = '') {
  let text=String(value || '');
  if (apiKey) text=text.replaceAll(apiKey,'[redacted]');
  return text.replace(/(?:AIza[\w-]{20,}|gsk_[\w-]+)/g,'[redacted]').replace(/([?&](?:key|api_key)=)[^\s&"']+/gi,'$1[redacted]').slice(0,700);
}
export async function providerError(response,apiKey,now=Date.now(),provider='Gemini') {
  let body;
  try {body=await response.json();} catch {body={};}
  const value=response.headers.get('retry-after');
  const wait=value ? Number.isFinite(Number(value)) ? Number(value)*1000 : +new Date(value)-now : 60000;
  const retryInfo=body.error?.details?.find(d=>d['@type']?.endsWith('RetryInfo'))?.retryDelay;
  const duration=retryInfo || body.error?.message?.match(/retry in ([\dhms.]+)/i)?.[1];
  let bodyWait=0;
  for(const match of String(duration || '').matchAll(/(\d+(?:\.\d+)?)(h|m|s)/g))bodyWait+=Number(match[1])*({h:3600000,m:60000,s:1000}[match[2]]);
  const detail=safeProviderMessage(body.error?.message,apiKey);
  return new ModelError(`${provider} request failed (HTTP ${response.status})${detail?`: ${detail}`:''}`,{
    status:response.status,providerCode:safeProviderMessage(typeof body.error?.code==='string'?body.error.code:body.error?.status,apiKey),
    retryAfterMs:Math.min(7*86400000,Math.max(1000,Math.max(Number.isFinite(wait)?wait:60000,bodyWait))) });
}
export class GeminiClient {
  provider='gemini';
  constructor({ apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    model = process.env.GEMINI_REASONING_MODEL || process.env.GEMINI_MODEL || 'gemini-3.6-flash', thinkingLevel = process.env.GEMINI_THINKING_LEVEL, fetchImpl = fetch,
    transport='interactions',keySlot='primary' } = {}) {
    if (!apiKey) throw new Error('Set GEMINI_API_KEY in the backend environment or local .env; do not paste it into chat');
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid Gemini model identifier');
    if (thinkingLevel && !['low','medium','high'].includes(thinkingLevel)) throw new Error('GEMINI_THINKING_LEVEL must be low, medium, or high');
    if(!['interactions','generateContent'].includes(transport))throw new Error('Invalid Gemini transport');
    Object.assign(this, { apiKey, model, thinkingLevel, fetchImpl,transport,keySlot });
    this.credentialScope=createHash('sha256').update(apiKey).digest('hex').slice(0,16);
  }
  async generate({ stage, prompt, images = [], timeoutMs = 300000,responseSchema=RESPONSE_SCHEMA,systemInstruction=SYSTEM,
    maxOutputTokens=16000,thinkingLevel=this.thinkingLevel }) {
    const input = [{ type: 'text', text: `Stage: ${stage}\n${prompt}` }];
    for (const image of images) {
      input.push({ type: 'text', text: `Page image for block ${image.blockId}` });
      input.push({ type: 'image', data: image.bytes.toString('base64'), mime_type: image.mimeType });
    }
    let payload = { model: this.model, store: false, system_instruction: systemInstruction, input,
      response_format: { type: 'text', mime_type: 'application/json', schema: responseSchema },
      generation_config: { max_output_tokens: maxOutputTokens, ...(thinkingLevel?{thinking_level:thinkingLevel}:{}) } };
    if(this.transport==='generateContent')payload={
      systemInstruction:{parts:[{text:systemInstruction}]},
      contents:[{role:'user',parts:input.map(p=>p.type==='text'?{text:p.text}:{inlineData:{data:p.data,mimeType:p.mime_type}})}],
      generationConfig:{maxOutputTokens,responseMimeType:'application/json',responseJsonSchema:responseSchema,
        ...(thinkingLevel?{thinkingConfig:{thinkingLevel}}:{})},
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > 19 * 1024 * 1024) throw new ModelError('Model request exceeds safe inline size; reduce analysis page batch size');
    let response;
    const endpoint=this.transport==='generateContent'?'models/'+this.model+':generateContent':'interactions';
    try { response = await this.fetchImpl('https://generativelanguage.googleapis.com/v1beta/'+endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey, 'Api-Revision': '2026-05-20' },
      body: JSON.stringify(payload) });
    } catch(error) {
      if (error.name==='TimeoutError' || error.name==='AbortError') throw new ModelError(`Gemini request timed out after ${Math.ceil(timeoutMs/1000)} seconds`,{status:408});
      throw new ModelError(`Gemini network request failed${error.cause?.code?` (${safeProviderMessage(error.cause.code)})`:''}`,{retryable:true});
    }
    if (!response.ok) throw await providerError(response,this.apiKey);
    let payloadResult;
    try {payloadResult=await response.json();}
    catch(error) {
      if (error.name==='TimeoutError' || error.name==='AbortError') throw new ModelError(`Gemini response timed out after ${Math.ceil(timeoutMs/1000)} seconds`,{status:408});
      throw new ModelError('Gemini returned a non-JSON API response',{retryable:true});
    }
    if (payloadResult.status && payloadResult.status !== 'completed') throw new ModelError(`Gemini response did not complete (${payloadResult.status})`);
    const parts=[...(payloadResult.outputs || []),...(payloadResult.steps || []).filter(s=>s.type==='model_output').flatMap(s=>s.content || [])];
    if(this.transport==='generateContent' && payloadResult.candidates?.[0]?.finishReason!=='STOP')throw new ModelError('Gemini response did not complete');
    const text = this.transport==='generateContent'?payloadResult.candidates[0].content.parts.filter(p=>!p.thought).map(p=>p.text||'').join(''):
      payloadResult.output_text || parts.filter(p => p.type === 'text').map(p => p.text || '').join('');
    if (!text) throw new ModelError('Gemini returned no structured text');
    let data;
    try { data = JSON.parse(text); } catch { throw new ModelError('Gemini returned invalid or truncated JSON'); }
    return { data, usage: payloadResult.usage || null, model: this.model };
  }
}

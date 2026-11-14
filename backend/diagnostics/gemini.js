import {providerError,safeProviderMessage} from '../analysis/gemini.js';

// Uses only a fixed synthetic prompt; never reads the company database or asset store.
export async function diagnoseGemini({apiKey=process.env.GEMINI_API_KEY||process.env.GOOGLE_API_KEY,
  model=process.env.GEMINI_REASONING_MODEL||process.env.GEMINI_MODEL||'gemini-3.6-flash',timeoutMs=Number(process.env.GEMINI_DIAGNOSTIC_TIMEOUT_MS || 300000),compareEndpoints=false,fetchImpl=fetch}={}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>2147483647) throw new Error('GEMINI_DIAGNOSTIC_TIMEOUT_MS must be a positive integer below 2147483648');
  if (!apiKey) return {model,status:'missing_key',message:'Set GEMINI_API_KEY in the ignored .env or backend secrets'};
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('Invalid model identifier');
  const checks=[];
  const request=async(name,url,payload)=>{
    const start=Date.now();
    try {
      const response=await fetchImpl(url,{method:payload?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),
        headers:{'x-goog-api-key':apiKey,...(payload?{'Content-Type':'application/json','Api-Revision':'2026-05-20'}:{})},
        ...(payload?{body:JSON.stringify(payload)}:{})});
      if (!response.ok) {
        const error=await providerError(response,apiKey);
        const check={name,http:response.status,elapsed_ms:Date.now()-start,reason:error.message,provider_code:error.providerCode};
        checks.push(check);return check;
      }
      const data=await response.json();
      const check={name,http:response.status,elapsed_ms:Date.now()-start,
        ...(name==='model_access'?{model_name:data.name}: {completion_status:data.status || data.candidates?.[0]?.finishReason || 'response_received'})};
      checks.push(check);return check;
    }catch(error){const check={name,status:error.name==='TimeoutError'?'timeout':'network_error',elapsed_ms:Date.now()-start,
      reason:safeProviderMessage(error.message,apiKey)};checks.push(check);return check;}
  };
  const access=await request('model_access',`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`);
  if (access.http===200) {
    await request('minimal_interaction','https://generativelanguage.googleapis.com/v1beta/interactions',
      {model,store:false,input:'Reply with the single word OK.',generation_config:{max_output_tokens:256}});
    if (compareEndpoints) await request('minimal_generateContent',`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {contents:[{role:'user',parts:[{text:'Reply with the single word OK.'}]}],generationConfig:{maxOutputTokens:256}});
  }
  const generation=checks.filter(c=>c.name!=='model_access');
  let status='request_failed';
  if ([401,403].includes(access.http)) status='authentication_or_access_error';
  else if (access.http===404) status='model_unavailable';
  else if (checks.some(c=>c.http===429)) status='quota_limited';
  else if (generation.length && generation.every(c=>c.http===503)) status='model_overloaded';
  else if (generation.some(c=>c.http===200)) status='minimal_request_succeeded';
  else if (checks.some(c=>c.status==='timeout')) status='timeout';
  return {model,status,key_has_model_access:access.http===200,checks,
    note:'Synthetic diagnostics only. No company documents sent; configured model and billing settings are unchanged.'};
}

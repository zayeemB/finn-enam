import {GroqClient} from '../analysis/groq.js';
import {safeProviderMessage} from '../analysis/gemini.js';
import {resultSchema} from '../analysis/schema.js';

// No database access or company input. Tests the actual structured-output adapter.
export async function diagnoseGroq({apiKey=process.env.GROQ_API_KEY,model=process.env.GROQ_MODEL || 'qwen/qwen3.8-27b',
  timeoutMs=20000,fetchImpl=fetch}={}) {
  if (!apiKey) return {provider:'groq',model,status:'missing_key',message:'Add GROQ_API_KEY to the ignored .env, then rerun npm run diagnose:groq'};
  const start=Date.now();
  try {
    const client=new GroqClient({apiKey,model,fetchImpl,maxOutputTokens:256});
    const response=await client.generate({stage:'connectivity_test',
      prompt:'Synthetic connectivity test. No source documents supplied. Return exactly {"covered_block_ids":[],"developments":[],"limitations":[]}.',timeoutMs});
    const data=resultSchema.parse(response.data);
    if (data.covered_block_ids.length || data.developments.length) throw new Error('Unexpected synthetic diagnostic result');
    return {provider:'groq',model,status:'minimal_request_succeeded',elapsed_ms:Date.now()-start,
      note:'Synthetic text only; page-image understanding and financial accuracy still require a live filing test.'};
  }catch(error) {
    return {provider:'groq',model,status:[401,403].includes(error.status)?'authentication_or_access_error':error.status===429?'quota_limited':
      error.status===503?'model_overloaded':error.status===408?'timeout':'request_failed',http:error.status,
      elapsed_ms:Date.now()-start,reason:safeProviderMessage(error.message,apiKey)};
  }
}

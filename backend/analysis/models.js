import {GeminiClient,ModelError} from './gemini.js';
import {GroqClient} from './groq.js';

const clientFor=provider=>{
  if (provider==='gemini') return new GeminiClient();
  if (provider==='groq') return new GroqClient();
  throw new Error('Analysis provider must be gemini or groq');
};
const cooldownKey=client=>`${client.provider || 'gemini'}:${client.model}`;

// A single ordered pair, with durable per-model cooldowns shared by worker invocations.
export class AnalysisModels {
  constructor(db,{clients,clock=()=>new Date(),fallback=process.env.GEMINI_FALLBACK_MODEL || '',legacyCooldown=true}={}) {
    this.db=db;this.clock=clock;this.routed=true;this.legacyCooldown=legacyCooldown;
    const provider=process.env.ANALYSIS_PROVIDER || 'gemini';
    const fallbackProvider=process.env.ANALYSIS_FALLBACK_PROVIDER;
    this.clients=clients || [clientFor(provider),...(fallbackProvider?[clientFor(fallbackProvider)]:
      provider==='gemini' && fallback?[new GeminiClient({model:fallback})]:[])];
    if (!this.clients.length || this.clients.length>2 || new Set(this.clients.map(c=>c.model)).size!==this.clients.length) throw new Error('Configure one primary and at most one distinct fallback model');
    this.model=this.clients[0].model;
    this.models=this.clients.map(c=>c.model);
  }
  async availability() {
    const rows=(await this.db.query('SELECT * FROM provider_backoff WHERE retry_after>$1',[this.clock()])).rows;
    return this.clients.map((client,index)=>({client,wait:rows.find(r=>r.provider===cooldownKey(client)) ||
      (this.legacyCooldown && index===0 && (client.provider || 'gemini')==='gemini'?rows.find(r=>r.provider==='gemini'):null)}));
  }
  unavailable(entries,errors=[]) {
    const next=entries.map(e=>e.wait).filter(Boolean).sort((a,b)=>+new Date(a.retry_after)-+new Date(b.retry_after))[0];
    const error=new ModelError(`All configured analysis models are cooling down${errors.length?`: ${errors.join('; ')}`:''}`,{
      status:next?.reason==='Provider rate limit'?429:503,
      retryAfterMs:next?Math.max(1000,+new Date(next.retry_after)-+this.clock()):60000});
    error.modelScoped=true;
    return error;
  }
  async generate(request) {
    const entries=await this.availability(),errors=[];
    for (const entry of entries) {
      if (entry.wait) continue;
      // The worker counts EVERY real request, including a failed primary attempt.
      const timeoutMs=(await request.onAttempt?.(entry.client.model)) ?? request.timeoutMs;
      try {
        const response=await entry.client.generate({...request,timeoutMs});
        return {...response,model:entry.client.model};
      } catch(error) {
        if (error.retryable!==true) throw error;
        errors.push(`${entry.client.model}: ${error.message}`);
        const prior=(await this.db.query('SELECT retry_after FROM provider_backoff WHERE provider=$1',[cooldownKey(entry.client)])).rows[0];
        // Persistent delay prevents other jobs/workers immediately repeating this failure.
        const delay=Math.max(60000,error.retryAfterMs || 0)+Math.floor(Math.random()*1000);
        const until=new Date(Math.max(+this.clock()+delay,prior?+new Date(prior.retry_after):0));
        entry.wait={retry_after:until,reason:error.status===429?'Provider rate limit':'Provider temporarily unavailable'};
        await this.db.query(`INSERT INTO provider_backoff VALUES ($1,$2,$3) ON CONFLICT(provider) DO UPDATE SET
          retry_after=greatest(provider_backoff.retry_after,excluded.retry_after),reason=excluded.reason`,
        [cooldownKey(entry.client),until,entry.wait.reason]);
      }
    }
    throw this.unavailable(entries,errors);
  }
}

// Backwards-compatible export for existing callers.
export {AnalysisModels as GeminiModels};

// Complementary stages, not a single interchangeable primary/fallback pair.
export class GeminiStages {
  constructor(db,{clock=()=>new Date(),extraction,reasoning}={}) {
    const router=(model,fallback)=>new AnalysisModels(db,{clock,legacyCooldown:false,clients:[new GeminiClient({model}),
      ...(fallback?[new GeminiClient({model:fallback})]:[])]});
    this.extraction=extraction || router(process.env.GEMINI_EXTRACTION_MODEL || 'gemini-3.1-flash-lite',process.env.GEMINI_EXTRACTION_FALLBACK_MODEL);
    this.reasoning=reasoning || router(process.env.GEMINI_REASONING_MODEL || 'gemini-3.6-flash',process.env.GEMINI_REASONING_FALLBACK_MODEL);
    this.routed=true;this.reuseValidatedPages=true;this.verifyExtraction=true;
    this.model=this.reasoning.model;
    this.models=[...new Set([...this.extraction.models,...this.reasoning.models])];
    this.clients=[...this.extraction.clients,...this.reasoning.clients];
    this.stageModels={page_extraction:this.extraction.models,reasoning:this.reasoning.models};
  }
  router(stage) { return stage==='page_extraction'?this.extraction:this.reasoning; }
  cacheModel(stage) { return this.router(stage).model; }
  async availability() { return [...await this.extraction.availability(),...await this.reasoning.availability()]; }
  generate(request) { return this.router(request.stage).generate(request); }
}

export function configuredModels(db,{clock=()=>new Date()}={}) {
  return (process.env.ANALYSIS_PROVIDER || 'gemini')==='gemini'?new GeminiStages(db,{clock}):new AnalysisModels(db,{clock});
}

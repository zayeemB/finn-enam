import { openDatabase } from './db.js';
import { openFiles } from './files.js';
import { collect } from './collector.js';
import { setPortfolio, companies, snapshot } from './repository.js';
import { extract } from './extraction/worker.js';
import { retryFailedExtractions } from './extraction/jobs.js';
import { analyse } from './analysis/worker.js';
import { digest,alerts,rules,configureRule,evaluateMarketAlerts } from './outputs.js';
import { parseArgs } from 'node:util';
import { diagnoseGemini } from './diagnostics/gemini.js';
import { diagnoseGroq } from './diagnostics/groq.js';
import { GroqClient } from './analysis/groq.js';
import { AnalysisModels } from './analysis/models.js';
import { runTick } from './monitor.js';
import { research } from './research/worker.js';
import { createResearch,researchJob } from './research/jobs.js';
import { initialiseApp } from './app-state.js';

export function analysisOptions(env=process.env,{hosted=false}={}) {
  const integer=(key,fallback)=>{
    const value=env[key]===undefined?fallback:Number(env[key]);
    if (!Number.isSafeInteger(value)||value<1) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  return {budgetMs:Math.min(integer('ANALYSIS_BUDGET_MS',180000),hosted?45000:180000),
    requestTimeoutMs:Math.min(integer('ANALYSIS_REQUEST_TIMEOUT_MS',30000),30000),
    untilDisclosureComplete:false,
    callLimit:integer('ANALYSIS_CALL_LIMIT',2),jobLimit:integer('ANALYSIS_JOB_LIMIT',1),
    pagesPerBatch:integer('ANALYSIS_PAGES_PER_BATCH',2),maxSynthesisChars:integer('ANALYSIS_SYNTHESIS_CHARS',180000)};
}

export function extractionOptions(env = process.env) {
  const number = (key, fallback, integer = true) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`${key} must be a positive ${integer ? 'integer' : 'number'}`);
    return value;
  };
  return { budgetMs: number('EXTRACTOR_BUDGET_MS', 45000), pageLimit: number('EXTRACTOR_PAGE_LIMIT', 10),
    jobLimit: number('EXTRACTOR_JOB_LIMIT', 3), pageTimeoutMs: number('EXTRACTOR_PAGE_TIMEOUT_MS', 20000),
    scale: number('EXTRACTOR_RENDER_SCALE', 1.5, false), maxPixels: number('EXTRACTOR_MAX_PIXELS', 6000000) };
}

export function collectionOptions(env = process.env) {
  const integer = (key, fallback) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a nonnegative integer`);
    return value;
  };
  return { budgetMs: integer('COLLECTOR_BUDGET_MS', 45000), companyLimit: integer('COLLECTOR_COMPANY_LIMIT', 5),
    downloadLimit: integer('COLLECTOR_DOWNLOAD_LIMIT', 10), overlapMinutes: integer('COLLECTOR_OVERLAP_MINUTES', 60),
    bootstrapHours: integer('COLLECTOR_BOOTSTRAP_HOURS', 24) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if(command==='diagnose-groq') {
    if(args.length) throw new Error('Groq diagnostics accepts no arguments');
    const result=await diagnoseGroq();
    console.log(JSON.stringify(result,null,2));
    if(result.status!=='minimal_request_succeeded') process.exitCode=1;
    return;
  }
  if(command==='diagnose-gemini') {
    const {values}=parseArgs({args,options:{stage:{type:'string',default:'reasoning'},'compare-endpoints':{type:'boolean',default:false}}});
    if (!['extraction','reasoning'].includes(values.stage)) throw new Error('Diagnostic stage must be extraction or reasoning');
    const model=values.stage==='extraction'?process.env.GEMINI_EXTRACTION_MODEL || 'gemini-3.1-flash-lite':
      process.env.GEMINI_REASONING_MODEL || 'gemini-3.6-flash';
    const result=await diagnoseGemini({model,compareEndpoints:values['compare-endpoints']});
    console.log(JSON.stringify(result,null,2));
    if(result.status!=='minimal_request_succeeded') process.exitCode=1;
    return;
  }
  const db = await openDatabase();
  try {
    let result;
    if(command==='tick') result=await runTick(db,await openFiles(),{budgetMs:330000});
    else if(command==='research') {
      await initialiseApp(db);
      if(args[0]==='run') result=await research(db,await openFiles(),{budgetMs:330000});
      else if(args[0]==='show') result=await researchJob(db,args[1]);
      else if(args.length>=2)result=await createResearch(db,{symbol:args[0],question:args.slice(1).join(' ')});
      else throw new Error('Use research SYMBOL "question", research run, or research show UUID');
    } else if (command === 'portfolio') {
      if (args.length) await setPortfolio(db, args);
      result = await companies(db);
    } else if (command === 'collect') {
      if (args.some(arg => !['--no-prices', '--revalidate'].includes(arg))) throw new Error('Use --no-prices and/or --revalidate; configure limits in .env');
      result = await collect(db, await openFiles(), { ...collectionOptions(), prices: !args.includes('--no-prices'), revalidate: args.includes('--revalidate') });
    } else if (command === 'extract') {
      if (args.some(arg => arg !== '--retry-failed')) throw new Error('Extraction supports --retry-failed; configure limits in .env');
      if (args.includes('--retry-failed')) await retryFailedExtractions(db);
      result = await extract(db, await openFiles(), extractionOptions());
    } else if (command==='analyse' || command==='analyse-groq') {
      if (args.some(arg=>arg!=='--retry-failed')) throw new Error('Analysis supports --retry-failed; configure limits/model in .env');
      if (args.includes('--retry-failed')) await db.query("UPDATE processing_jobs SET failure_count=0,next_attempt_at=NULL,error_kind=NULL WHERE job_type='analyse' AND status='failed'");
      result=await analyse(db,await openFiles(),{...analysisOptions(),...(command==='analyse-groq'?
        {pagesPerBatch:1,model:new AnalysisModels(db,{clients:[new GroqClient()]})}:{})});
    } else if (command==='digest') {
      const {values}=parseArgs({args,options:{hours:{type:'string'},from:{type:'string'},to:{type:'string'}}});
      if (!!values.from!==!!values.to) throw new Error('Provide both --from and --to');
      const hours=values.hours===undefined?24:Number(values.hours);
      if (!Number.isFinite(hours)||hours<=0) throw new Error('Digest hours must be positive');
      result=await digest(db,{hours,start:values.from,end:values.to || new Date()});
    } else if (command==='alerts') result=await alerts(db);
    else if (command==='evaluate-alerts') result={created:await evaluateMarketAlerts(db)};
    else if (command==='rules') {
      const {values}=parseArgs({args,options:{'price-percent':{type:'string'},'volume-multiple':{type:'string'},'volume-sessions':{type:'string'},categories:{type:'string'}}});
      const current=await rules(db);
      if (values['price-percent']!==undefined) await configureRule(db,'price_move',{percent:Number(values['price-percent'])});
      if (values['volume-multiple']!==undefined || values['volume-sessions']!==undefined) {
        const settings=current.find(r=>r.rule_type==='volume_spike')?.settings;
        if (!settings) throw new Error('Configure a portfolio first');
        await configureRule(db,'volume_spike',{multiple:Number(values['volume-multiple'] ?? settings.multiple),sessions:Number(values['volume-sessions'] ?? settings.sessions)});
      }
      if (values.categories!==undefined) {
        const {CATEGORIES}=await import('./analysis/schema.js');
        const categories=values.categories.split(',').filter(Boolean);
        if (categories.some(c=>!CATEGORIES.includes(c))) throw new Error('Unknown alert category');
        await configureRule(db,'announcement',{categories});
      }
      result=await rules(db);
    } else if (command === 'inspect') result = await snapshot(db);
    else throw new Error('Commands: portfolio, collect, extract, analyse, digest, alerts, rules, evaluate-alerts, inspect');
    console.log(JSON.stringify(result, null, 2));
    if (['partial','provider_unavailable','rate_limited'].includes(result?.status)) process.exitCode = 1;
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

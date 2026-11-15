import {marketContext} from './research/market.js';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {openDatabase} from './db.js';
import {openFiles} from './files.js';
import {PORTFOLIO,companies} from './repository.js';
import {initialiseApp,settings,updateSettings,changeCompany,status,watchlist} from './app-state.js';
import {digest,alerts} from './outputs.js';
import {createResearch,researchJob,deleteResearch} from './research/jobs.js';

const hash=token=>createHash('sha256').update(token).digest('hex');
const id=value=>z.uuid().parse(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function createAppHandler({db:sharedDb,files:sharedFiles,accessCode=process.env.DEMO_ACCESS_CODE,clock=()=>new Date(),market:injectedMarket}={}) {
  const failures=new Map(),market=injectedMarket||marketContext({clock});
  return async function handler(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    let db;
    try {
      if(!accessCode || accessCode.length<12) throw fail('Configure a demo access code with at least 12 characters',503);
      const resource=req.query?.resource || 'session';
      if(typeof resource!=='string') throw fail('Invalid resource');
      const mutation=!['GET','HEAD'].includes(req.method);
      // Non-simple header blocks cross-site form posts; Origin, when present,
      // must match the configured public origin or this request's own host.
      if(mutation && req.headers['x-finn-client']!=='web') throw fail('Missing X-Finn-Client header',403);
      if(req.headers.origin) {
        const expected=process.env.APP_ORIGIN || `${process.env.VERCEL?'https':'http'}://${req.headers.host}`;
        if(req.headers.origin!==expected) throw fail('Cross-origin request denied',403);
      }
      db=sharedDb || await openDatabase();await initialiseApp(db,clock());
      const secure=!!process.env.VERCEL || process.env.APP_ORIGIN?.startsWith('https:');
      const cookie=value=>`finn_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${value?43200:0}${secure?'; Secure':''}`;
      if(resource==='session' && req.method==='POST') {
        const key=req.socket?.remoteAddress || 'demo';const attempt=failures.get(key);
        if(attempt && attempt.until>+clock() && attempt.count>=5) throw fail('Too many login attempts; retry in a minute',429);
        const body=z.object({access_code:z.string().max(256)}).strict().parse(req.body);
        const actual=hash(body.access_code),expected=hash(accessCode);
        if(!timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) {
          if(failures.size>1000) failures.clear();
          failures.set(key,{count:attempt?.until>+clock()?attempt.count+1:1,until:+clock()+60000});throw fail('Invalid access code',401);
        }
        failures.delete(key);
        await db.query('DELETE FROM app_sessions WHERE expires_at<=$1',[clock()]);
        const token=randomBytes(32).toString('base64url');
        await db.query('INSERT INTO app_sessions VALUES ($1,$2,$3)',[hash(token),clock(),new Date(+clock()+43200000)]);
        res.setHeader('Set-Cookie',cookie(token));return res.status(200).json({authenticated:true});
      }
      const token=(req.headers.cookie || '').split(';').map(s=>s.trim()).find(s=>s.startsWith('finn_session='))?.slice(13);
      const authenticated=token && (await db.query('SELECT 1 FROM app_sessions WHERE token_hash=$1 AND expires_at>$2',[hash(token),clock()])).rows.length;
      if(resource==='session' && req.method==='GET') return res.status(200).json({authenticated:!!authenticated});
      if(!authenticated) throw fail('Sign in to the demo',401);
      if(resource==='session' && req.method==='DELETE') {
        await db.query('DELETE FROM app_sessions WHERE token_hash=$1',[hash(token)]);res.setHeader('Set-Cookie',cookie(''));return res.status(200).json({authenticated:false});
      }
      let result;
      if(resource==='portfolio' && req.method==='GET') result=await watchlist(db);
      else if(resource==='portfolio' && ['POST','DELETE'].includes(req.method)) {
        const {symbol}=z.object({symbol:z.string().min(1).max(40)}).strict().parse(req.body);result=await changeCompany(db,symbol,req.method==='DELETE',clock());
      } else if(resource==='market' && req.method==='GET') {
        const name=z.string().min(1).max(40).parse(req.query.symbol);result=await market(name);
      } else if(resource==='settings' && req.method==='GET') result=await settings(db);
      else if(resource==='settings' && req.method==='PATCH') result=await updateSettings(db,req.body,clock());
      else if(resource==='status' && req.method==='GET') result=await status(db);
      else if(resource==='refresh' && req.method==='POST') {
        await db.query('UPDATE monitoring_state SET refresh_requested_at=$2 WHERE portfolio_id=$1',[PORTFOLIO,clock()]);result={status:'queued'};
      } else if(resource==='digest' && req.method==='GET') {
        const {from,to,hours}=req.query || {};
        if(!!from!==!!to) throw fail('Provide both from and to');
        const window=hours===undefined?(await settings(db)).digest_hours:Number(hours);
        if(!Number.isFinite(window)||window<=0||window>8760) throw fail('Invalid digest hours');
        result=await digest(db,{start:from,end:to || clock(),hours:window});
      } else if(resource==='digests' && req.method==='GET') result=(await db.query('SELECT * FROM digest_runs WHERE portfolio_id=$1 ORDER BY window_end DESC LIMIT 30',[PORTFOLIO])).rows;
      else if(resource==='alerts' && req.method==='GET') result=await alerts(db);
      else if(resource==='notifications' && req.method==='GET') result=(await db.query(`SELECT n.*,a.message,d.window_start,d.window_end FROM notifications n
        LEFT JOIN alerts a ON n.kind='alert' AND a.id=n.reference_id LEFT JOIN digest_runs d ON n.kind='digest' AND d.id=n.reference_id
        WHERE n.portfolio_id=$1 ORDER BY n.created_at DESC LIMIT 100`,[PORTFOLIO])).rows;
      else if(resource==='notifications' && req.method==='PATCH') {
        const body=z.object({id:z.uuid()}).strict().parse(req.body);
        const updated=await db.query('UPDATE notifications SET read_at=coalesce(read_at,$3) WHERE id=$1 AND portfolio_id=$2 RETURNING id,read_at',[body.id,PORTFOLIO,clock()]);
        if(!updated.rows.length) throw fail('Notification not found',404);result=updated.rows[0];
      } else if(resource==='company' && req.method==='GET') {
        const company=(await db.query('SELECT * FROM companies WHERE nse_symbol=$1',[String(req.query.symbol || '').toUpperCase()])).rows[0];
        if(!company) throw fail('Company not found',404);
        result={company,observations:(await db.query('SELECT * FROM observations WHERE company_id=$1 AND is_current ORDER BY period_end DESC,metric LIMIT 500',[company.id])).rows,
          events:(await db.query('SELECT * FROM events WHERE company_id=$1 ORDER BY updated_at DESC LIMIT 100',[company.id])).rows,
          evidence:(await db.query(`SELECT e.id,e.event_id,e.event_version,e.source_url,e.location,e.evidence_snapshot,e.retained_image_path IS NOT NULL AS has_image
            FROM event_evidence e JOIN events v ON v.id=e.event_id WHERE v.company_id=$1 ORDER BY v.updated_at DESC LIMIT 300`,[company.id])).rows};
      } else if(resource==='research' && req.method==='POST') {
        const body=z.object({symbol:z.string().min(1).max(40),question:z.string().trim().max(2000).optional(),source_policy:z.enum(['primary','assignment']).optional(),annual_reports:z.number().int().min(1).max(3).optional(),transcripts:z.number().int().min(1).max(4).optional()}).strict().parse(req.body);
        result=await createResearch(db,body,clock());return res.status(202).json(result);
      } else if(resource==='research' && req.method==='GET') result=req.query.id?await researchJob(db,id(req.query.id)):
        (await db.query('SELECT r.id,c.nse_symbol,r.question,r.status,r.progress,r.created_at,r.completed_at,r.error,r.next_attempt_at FROM research_jobs r JOIN companies c ON c.id=r.company_id ORDER BY created_at DESC LIMIT 30')).rows;
      else if(resource==='research' && req.method==='DELETE') {
        const body=z.object({id:z.uuid()}).strict().parse(req.body);
        result=await deleteResearch(db,body.id);
        if(!result)throw fail('Research job not found',404);
      } else if(resource==='research-retry' && req.method==='POST') {
        const body=z.object({id:z.uuid()}).strict().parse(req.body);
        result=await db.transaction(async tx=>{
          const row=(await tx.query("UPDATE research_jobs SET status='queued',error=NULL,error_kind=NULL,next_attempt_at=NULL,attempts=0,started_at=NULL,completed_at=NULL,result=CASE WHEN result->>'report_type'='source_excerpts' THEN NULL ELSE result END,research_state=research_state - 'brief_started_at' - 'calls' WHERE id=$1 AND (status='failed' OR (status='partial' AND result->>'report_type'='source_excerpts')) RETURNING id,status",[body.id])).rows[0];
          if(row) {
            await tx.query("UPDATE research_documents SET status='pending',error=NULL WHERE research_job_id=$1 AND status='failed'",[body.id]);
            await tx.query(`UPDATE processing_jobs SET failure_count=0,next_attempt_at=NULL WHERE job_type='extract' AND status='failed'
              AND disclosure_id IN (SELECT disclosure_id FROM research_documents WHERE research_job_id=$1)`,[body.id]);
          }
          return row;
        });
        if(!result) throw fail('Failed research job not found',404);
      } else if(resource==='evidence' && req.method==='GET') {
        const row=(await db.query(`SELECT retained_image_path AS image FROM event_evidence WHERE id=$1
          UNION ALL SELECT retained_image_path FROM research_evidence WHERE id=$1`,[id(req.query.id)])).rows[0];
        if(!row?.image) throw fail('Evidence image unavailable',404);
        const body=await (sharedFiles || await openFiles()).get(row.image);
        res.setHeader('Content-Type','image/png');return res.status(200).send(body);
      } else throw fail('Resource or method not supported',404);
      if(result===null) throw fail('Not found',404);
      return res.status(200).json(result);
    } catch(error) {
      const status=error instanceof z.ZodError?400:error.status || (/Invalid NSE|Digest /.test(error.message)?400:500);
      if(status===500) console.error('App request failed:',error.message);
      return res.status(status).json({error:status===500?'Request failed; check backend logs':error instanceof z.ZodError?'Invalid request data':error.message});
    } finally {if(db && !sharedDb) await db.close();}
  };
}

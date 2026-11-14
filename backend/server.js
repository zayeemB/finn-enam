import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {openDatabase} from './db.js';
import {openFiles} from './files.js';
import {initialiseApp} from './app-state.js';
import {createAppHandler} from './app-api.js';
import {runTick} from './monitor.js';
import {extract} from './extraction/worker.js';
import {research} from './research/worker.js';

// Each loop yields during I/O and finishes its current checkpoint before shutdown.
// Extraction and question research must keep moving during a slow monitoring call.
function backgroundLoop(name,run,delayAfter) {
  let stopped=false,timer,active=Promise.resolve();
  const schedule=delay=>{
    timer=setTimeout(()=>{
      active=Promise.resolve().then(run).then(result=>{
        if(!stopped)schedule(delayAfter(result));
      }).catch(error=>{
        console.error(name,error.message);
        if(!stopped)schedule(5000);
      });
    },delay);
    timer.unref();
  };
  schedule(100);
  return ()=>{stopped=true;clearTimeout(timer);return active;};
}

export async function startServer({port=Number(process.env.PORT || 3001),accessCode=process.env.DEMO_ACCESS_CODE,
  automatic=true,db:injectedDb,files:injectedFiles,tick=runTick,preparePages=extract,runResearch=research}={}) {
  if(!Number.isSafeInteger(port)||port<0||port>65535) throw new Error('Invalid PORT');
  const db=injectedDb || await openDatabase(),files=injectedFiles || await openFiles();
  await initialiseApp(db);
  if(!accessCode) {accessCode=randomBytes(12).toString('base64url');console.log(`Temporary demo access code: ${accessCode}`);}
  const handler=createAppHandler({db,files,accessCode});
  const server=createServer(async(req,res)=>{
    // Never bind the local demo to a public interface or accept DNS-rebinding hosts.
    const host=req.headers.host || '';
    if(!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host)){res.writeHead(403);return res.end();}
    const url=new URL(req.url,`http://${host}`);
    const assets={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8']};
    if(assets[url.pathname] && ['GET','HEAD'].includes(req.method)) {
      try {
        const [name,type]=assets[url.pathname],body=await readFile(new URL(`../web/${name}`,import.meta.url));
        res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
        return res.end(req.method==='HEAD'?undefined:body);
      } catch {res.writeHead(500);return res.end('Frontend files unavailable');}
    }
    if(url.pathname!=='/api/app'){res.writeHead(404,{'Content-Type':'application/json'});return res.end('{"error":"Use /api/app?resource=session"}');}
    try {
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>16384){res.writeHead(413);return res.end();}chunks.push(chunk);}
      const body=Buffer.concat(chunks).toString('utf8');
      req.query=Object.fromEntries(url.searchParams);req.body=body?JSON.parse(body):undefined;
      res.status=code=>{res.statusCode=code;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};res.send=value=>res.end(value);
      await handler(req,res);
    }catch {if(!res.headersSent)res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":"Invalid request body"}');}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const workers=automatic?[
    backgroundLoop('Monitoring',()=>tick(db,files,{budgetMs:330000,localWorkers:true}),()=>5000),
    backgroundLoop('PDF preparation',()=>preparePages(db,files,{budgetMs:45000,pageLimit:40,jobLimit:3}),r=>r.pagesSaved?100:3000),
    backgroundLoop('Research',()=>runResearch(db,files,{budgetMs:330000}),r=>r.status==='waiting'&&!r.error&&!r.progress?.startsWith('Waiting for extraction')?250:3000),
  ]:[];
  return {server,port:server.address().port,async close(){
    await Promise.all([new Promise(resolve=>server.close(resolve)),...workers.map(stop=>stop())]);
    if(!injectedDb)await db.close();
  }};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const app=await startServer();console.log(`FINN backend listening on http://127.0.0.1:${app.port}`);
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}

import {openDatabase} from '../db.js';
import {openFiles} from '../files.js';
import {research} from './worker.js';
import {waitUntil} from '@vercel/functions';
export async function runHostedResearch({openDb=openDatabase,files=openFiles,run=research,budgetMs=45000}={}){
 const db=await openDb(),end=Date.now()+budgetMs;
 try{
  let result;
  do{result=await run(db,await files(),{budgetMs:Math.max(1,end-Date.now())});}
  while(result.status==='waiting'&&!result.error&&!result.progress?.startsWith('Waiting for extraction')&&Date.now()+5000<end);
  return result;
 }finally{await db.close();}
}
export function hostedResearchTrigger({enabled=!!process.env.VERCEL,afterResponse=waitUntil,work=runHostedResearch}={}){
 let active;
 return job=>{
  if(!enabled||!job||!['queued','waiting'].includes(job.status)||job.next_attempt_at&&Date.parse(job.next_attempt_at)>Date.now())return false;
  if(active)return false;
  active=Promise.resolve().then(work).catch(error=>console.error('Hosted research failed:',error.message)).finally(()=>{active=null;});
  afterResponse(active);return true;
 };
}

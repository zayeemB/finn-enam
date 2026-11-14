import { openDatabase } from '../backend/db.js';
import { openFiles } from '../backend/files.js';
import { analyse } from '../backend/analysis/worker.js';
import { analysisOptions } from '../backend/cli.js';
import { authorised } from './collect.js';
export const config={maxDuration:60};
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  if (!authorised(req)) return res.status(401).json({error:'Unauthorised'});
  let db;
  try {
    const options=analysisOptions(process.env,{hosted:true});
    db=await openDatabase();
    return res.status(200).json(await analyse(db,await openFiles(),options));
  } catch (error) {console.error('Analysis invocation failed:',error.message);return res.status(500).json({error:'Analysis failed; check backend logs/configuration'});}
  finally {if(db) await db.close();}
}

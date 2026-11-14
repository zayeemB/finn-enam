import {openDatabase} from '../backend/db.js';
import {openFiles} from '../backend/files.js';
import {runTick} from '../backend/monitor.js';
import {authorised} from './collect.js';
export const config={maxDuration:60};
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if(!['GET','POST'].includes(req.method)) return res.status(405).json({error:'Method not allowed'});
  if(!authorised(req)) return res.status(401).json({error:'Unauthorised'});
  let db;
  try{db=await openDatabase();return res.status(200).json(await runTick(db,await openFiles()));}
  catch(error){console.error('Tick failed:',error.message);return res.status(500).json({error:'Tick failed'});}
  finally{if(db) await db.close();}
}

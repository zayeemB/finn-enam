import { openDatabase } from '../backend/db.js';
import { alerts } from '../backend/outputs.js';
import { authorised } from './collect.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if (!authorised(req)) return res.status(401).json({error:'Unauthorised'});
  let db;
  try {db=await openDatabase();return res.status(200).json(await alerts(db));}
  catch {return res.status(500).json({error:'Alerts unavailable'});}
  finally {if(db) await db.close();}
}

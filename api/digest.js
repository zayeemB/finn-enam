import { openDatabase } from '../backend/db.js';
import { digest } from '../backend/outputs.js';
import { authorised } from './collect.js';
export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method!=='GET') return res.status(405).json({error:'Method not allowed'});
  if (!authorised(req)) return res.status(401).json({error:'Unauthorised'});
  const {from,to,hours}=req.query || {};
  if (!!from!==!!to || (hours!==undefined && (!Number.isFinite(Number(hours)) || Number(hours)<=0))) return res.status(400).json({error:'Invalid digest window'});
  let db;
  try {db=await openDatabase();return res.status(200).json(await digest(db,{start:from,end:to || new Date(),hours:hours===undefined?24:Number(hours)}));}
  catch (error) {
    if(error.message.startsWith('Digest ')) return res.status(400).json({error:error.message});
    console.error('Digest read failed');return res.status(500).json({error:'Digest unavailable'});
  }
  finally {if(db) await db.close();}
}

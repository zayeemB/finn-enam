import {authorised} from './collect.js';
import {runHostedResearch} from '../backend/research/hosted.js';
export const config={maxDuration:60};
export function createResearchWorkerHandler({authorise=authorised,run=runHostedResearch}={}){
 return async(req,res)=>{
  res.setHeader('Cache-Control','no-store');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  if(!authorise(req))return res.status(401).json({error:'Unauthorised'});
  try{return res.status(200).json(await run());}catch(error){console.error('Research worker failed:',error.message);return res.status(500).json({error:'Research worker failed'});}
 };
}
export default createResearchWorkerHandler();

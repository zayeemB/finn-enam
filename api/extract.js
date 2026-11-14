import { openDatabase } from '../backend/db.js';
import { openFiles } from '../backend/files.js';
import { extractionOptions } from '../backend/cli.js';
import { extract } from '../backend/extraction/worker.js';
import { authorised } from './collect.js';

export const config = { maxDuration: 60 };
export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(request.method)) return response.status(405).json({ error: 'Method not allowed' });
  if (!authorised(request)) return response.status(401).json({ error: 'Unauthorised' });
  let db;
  try {
    const options = extractionOptions();
    if (options.budgetMs > 45000 || options.pageTimeoutMs > 40000 || options.maxPixels > 6000000) throw new Error('Hosted extraction limits exceed safe invocation bounds');
    db = await openDatabase();
    return response.status(200).json(await extract(db, await openFiles(), options));
  } catch (error) {
    console.error('Extraction invocation failed:', error.message);
    return response.status(500).json({ error: 'Extraction failed; check backend logs' });
  } finally { if (db) await db.close(); }
}

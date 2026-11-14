import { timingSafeEqual } from 'node:crypto';
import { openDatabase } from '../backend/db.js';
import { openFiles } from '../backend/files.js';
import { collect } from '../backend/collector.js';
import { collectionOptions } from '../backend/cli.js';

export const config = { maxDuration: 60 };
export function authorised(request, secret = process.env.CRON_SECRET) {
  if (!secret) return false;
  const actual = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(request.method)) return response.status(405).json({ error: 'Method not allowed' });
  if (!authorised(request)) return response.status(401).json({ error: 'Unauthorised' });
  let db;
  try {
    db = await openDatabase();
    const options = collectionOptions();
    if (options.budgetMs > 45000) throw new Error('Hosted collection budget cannot exceed 45000 ms');
    const result = await collect(db, await openFiles(), options);
    return response.status(200).json(result);
  } catch (error) {
    console.error('Collector invocation failed:', error.message);
    return response.status(500).json({ error: 'Collection failed; check backend logs' });
  } finally { if (db) await db.close(); }
}

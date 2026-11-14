import { mkdir, writeFile, readFile, rename, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './sources.js';

export function localFiles(root = process.env.FINN_DATA_DIR || 'data/node') {
  root = resolve(root, 'assets');
  const pathFor = key => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid storage key');
    return resolve(root, key.slice(0, 2), key);
  };
  return {
    backend: 'local',
    async put(body) {
      const key = hash(body), target = pathFor(key);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, body); await rename(temporary, target);
      return key;
    },
    get: key => readFile(pathFor(key)),
    async remove(key) { await unlink(pathFor(key)).catch(e => { if (e.code !== 'ENOENT') throw e; }); },
    async exists(key) { try { return hash(await readFile(pathFor(key))) === key; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } },
  };
}

export async function blobFiles() {
  const { put, get, del, head } = await import('@vercel/blob');
  const pathname = key => { if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid storage key'); return `finn/temporary/${key}`; };
  return {
    backend: 'vercel-blob',
    async put(body, { contentType } = {}) { const key = hash(body); await put(pathname(key), body, { access: 'private', addRandomSuffix: false, allowOverwrite: true, ...(contentType ? { contentType } : {}) }); return key; },
    async get(key) { const result = await get(pathname(key), { access: 'private', useCache: false }); if (!result) throw Object.assign(new Error('Temporary blob unavailable'),{code:'ENOENT'}); if (result.statusCode!==200) throw new Error('Unexpected temporary blob response'); return Buffer.from(await new Response(result.stream).arrayBuffer()); },
    async exists(key) { try { await head(pathname(key)); return true; } catch (error) { if (error.status === 404 || error.name === 'BlobNotFoundError') return false; throw error; } },
    remove: key => del(pathname(key)),
  };
}

export async function openFiles() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return blobFiles();
  if (process.env.VERCEL) throw new Error('BLOB_READ_WRITE_TOKEN is required on Vercel for files shared with the worker');
  return localFiles();
}

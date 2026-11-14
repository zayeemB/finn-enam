import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
const TRUSTED = ['nseindia.com', 'bseindia.com', 'finance.yahoo.com', 'screener.in'];
const privateNetworks=new BlockList();
for(const [net,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.168.0.0',16],['224.0.0.0',4],['240.0.0.0',4]])privateNetworks.addSubnet(net,prefix,'ipv4');
for(const [net,prefix] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['::ffff:0:0',96]])privateNetworks.addSubnet(net,prefix,'ipv6');

export function validateSourceUrl(value,allowedHosts=[]) {
  const url = new URL(value);
  const hosts = [...TRUSTED, ...allowedHosts, ...(process.env.EXTRA_SOURCE_HOSTS || '').split(',').filter(Boolean)];
  if (url.protocol !== 'https:' || isIP(url.hostname.replace(/^\[|\]$/g,'')) || !url.hostname.includes('.') || /\.(?:localhost|local|internal)$/.test(url.hostname) || url.username || url.password || (url.port && url.port !== '443') ||
    !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(`Untrusted source URL: ${url.origin}`);
  }
  return url.href;
}

export class SourceClient {
  constructor({ fetchImpl = fetch, deadline = Date.now() + 45000, maxBytes = 60 * 1024 * 1024,allowedHosts=[],resolveHost=lookup } = {}) {
    Object.assign(this, { fetchImpl, deadline, maxBytes,allowedHosts,resolveHost });
    this.cookies = new Map();
  }
  async get(value, headers = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let url = validateSourceUrl(value,this.allowedHosts);
      try {
        for (let redirects = 0; redirects <= 5; redirects++) {
          const remaining = this.deadline - Date.now();
          if (remaining < 100) throw new Error('Collection time budget exhausted');
          const hostname = new URL(url).hostname;
          if(!TRUSTED.some(host=>hostname===host || hostname.endsWith('.'+host))) {
            const addresses=await this.resolveHost(hostname,{all:true});
            if(!addresses.length || addresses.some(a=>privateNetworks.check(a.address,a.family===6?'ipv6':'ipv4')))throw Object.assign(new Error('Source hostname resolves to a private network'),{retryable:false});
          }
          const response = await this.fetchImpl(url, { redirect: 'manual',
            signal: AbortSignal.timeout(Math.min(15000, remaining)),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FINN/0.2)', Accept: '*/*',
              ...(this.cookies.get(hostname) ? { Cookie: this.cookies.get(hostname) } : {}), ...headers } });
          const cookies = response.headers.getSetCookie?.() || [];
          if (cookies.length) {
            const merged = new Map((this.cookies.get(hostname) || '').split('; ').filter(Boolean).map(c => [c.split('=')[0], c]));
            for (const cookie of cookies) merged.set(cookie.split('=')[0], cookie.split(';')[0]);
            this.cookies.set(hostname, [...merged.values()].join('; '));
          }
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            url = validateSourceUrl(new URL(response.headers.get('location'), url).href,this.allowedHosts);
            continue;
          }
          if (!response.ok && response.status !== 304) {
            await response.body?.cancel();
            const error = new Error(`HTTP ${response.status}: ${url}`);
            error.retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
            throw error;
          }
          const chunks = []; let size = 0;
          if (response.body) for await (const chunk of response.body) {
            size += chunk.length;
            if (size > this.maxBytes) throw Object.assign(new Error('Source exceeds download size limit'), { retryable: false });
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks);
          return { url, status: response.status, body, headers: response.headers,
            json() { try { return JSON.parse(body.toString('utf8')); } catch { throw new Error(`Invalid source JSON: ${url}`); } } };
        }
        throw Object.assign(new Error('Too many source redirects'), { retryable: false });
      } catch (error) {
        if (error.retryable === false || attempt === 2 || Date.now() + 1000 >= this.deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
  }
}

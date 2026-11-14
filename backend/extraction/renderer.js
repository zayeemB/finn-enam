import { Worker } from 'node:worker_threads';

export class RenderSession {
  constructor({ timeoutMs = 20000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.thread = new Worker(new URL('./render-thread.js', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.thread.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error), { unsupported: message.unsupported }));
      else pending.resolve(message.result);
    });
    this.thread.on('error', error => this.rejectAll(error));
    this.thread.on('exit', code => this.rejectAll(new Error(`Document renderer stopped (${code})`)));
  }
  rejectAll(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  request(message, timeoutMs = this.timeoutMs, transfer = []) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Document parsing/rendering timed out'));
        this.close();
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { resolve, reject, timer });
      this.thread.postMessage({ id, ...message }, transfer);
    });
  }
  open(body, options, timeout) {
    const bytes = Uint8Array.from(body);
    return this.request({ action: 'open', bytes, options }, timeout, [bytes.buffer]);
  }
  page(number, timeout) { return this.request({ action: 'page', page: number }, timeout); }
  index(timeout) { return this.request({action:'index'},timeout); }
  async close() { this.rejectAll(new Error('Renderer closed')); await this.thread.terminate(); }
}

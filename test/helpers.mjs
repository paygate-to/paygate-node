// Records requests and replays queued responses, in place of fetch.
export class FakeFetch {
  constructor() {
    this.requests = [];
    this.queue = [];
    this.fetch = this.fetch.bind(this);
  }

  respond(body, status = 200) {
    this.queue.push({ status, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return this;
  }

  fail(message = 'connect ECONNREFUSED') {
    this.queue.push({ error: new TypeError('fetch failed', { cause: new Error(message) }) });
    return this;
  }

  hang() {
    this.queue.push({ hang: true });
    return this;
  }

  async fetch(url, init = {}) {
    this.requests.push({ url, ...init });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`No response queued for ${init.method} ${url}`);
    }
    if (next.error) {
      throw next.error;
    }
    if (next.hang) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    return { status: next.status, text: async () => next.body };
  }

  get last() {
    return this.requests[this.requests.length - 1];
  }

  get lastPath() {
    return new URL(this.last.url).pathname;
  }

  get lastQuery() {
    const url = this.last.url;
    const i = url.indexOf('?');
    return i === -1 ? '' : url.slice(i + 1);
  }
}

// Local worker (tools/disclaimer-worker). Loopback only; see README there.
export const WORKER_URL = 'http://127.0.0.1:43128';

export async function w(path, opts = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    signal: opts.signal || AbortSignal.timeout(opts.timeout || 15000),
    targetAddressSpace: 'loopback',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
  return data;
}

const MAX_BACKOFF_MS = 30_000;

function retryAfterMilliseconds(value, now) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(String(value).trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

export function retryDelayMilliseconds({ attempt, retryAfter, now = Date.now(), random = Math.random }) {
  const exponential = Math.min(MAX_BACKOFF_MS, 250 * (2 ** Math.max(0, attempt - 1)));
  const serverDelay = retryAfterMilliseconds(retryAfter, now);
  const base = serverDelay === null ? exponential : Math.max(exponential, serverDelay);
  // Jitter is additive so Retry-After remains a minimum delay.
  const boundedBase = Math.min(MAX_BACKOFF_MS, base);
  return Math.min(MAX_BACKOFF_MS, Math.round(boundedBase + random() * Math.min(1_000, Math.max(50, boundedBase * 0.2))));
}

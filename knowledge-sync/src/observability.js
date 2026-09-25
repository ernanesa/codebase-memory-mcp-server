const counters = new Map();
const gauges = new Map();
const histograms = new Map();
const bucketConfigs = new Map();

const DEFAULT_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function configureBuckets(name, buckets) {
  bucketConfigs.set(name, buckets);
}

function serializeLabels(labels) {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== null).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `{${entries.map(([name, value]) => `${name}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}` : '';
}

function metricKey(name, labels) { return JSON.stringify([name, labels]); }

export function increment(name, labels = {}, value = 1) {
  const k = metricKey(name, labels);
  counters.set(k, (counters.get(k) || 0) + value);
}

export function gauge(name, value, labels = {}) {
  gauges.set(metricKey(name, labels), Number(value) || 0);
}

export function observe(name, value, labels = {}) {
  const k = metricKey(name, labels);
  let current = histograms.get(k);
  if (!current) {
    const thresholds = bucketConfigs.get(name) || DEFAULT_HISTOGRAM_BUCKETS;
    current = { count: 0, sum: 0, buckets: Object.fromEntries(thresholds.map(b => [b, 0])) };
    histograms.set(k, current);
  }
  const val = Number(value) || 0;
  current.count += 1;
  current.sum += val;
  for (const b in current.buckets) {
    if (val <= Number(b)) current.buckets[b] += 1;
  }
}

export function metricsText() {
  gauge('knowledge_sync_process_resident_memory_bytes', process.memoryUsage().rss);
  gauge('knowledge_sync_process_heap_used_bytes', process.memoryUsage().heapUsed);
  gauge('knowledge_sync_process_uptime_seconds', process.uptime());
  const lines = [];
  for (const [k, value] of counters) {
    const [name, labels] = JSON.parse(k);
    lines.push(`${name}${serializeLabels(labels)} ${value}`);
  }
  for (const [k, value] of gauges) {
    const [name, labels] = JSON.parse(k);
    lines.push(`${name}${serializeLabels(labels)} ${value}`);
  }
  for (const [k, value] of histograms) {
    const [name, labels] = JSON.parse(k);
    for (const b in value.buckets) {
      lines.push(`${name}_bucket${serializeLabels({ ...labels, le: b })} ${value.buckets[b]}`);
    }
    lines.push(`${name}_bucket${serializeLabels({ ...labels, le: '+Inf' })} ${value.count}`);
    lines.push(`${name}_count${serializeLabels(labels)} ${value.count}`);
    lines.push(`${name}_sum${serializeLabels(labels)} ${value.sum}`);
  }
  return `${lines.join('\n')}\n`;
}

export function log(level, event, fields = {}) {
  const safe = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, service: 'knowledge-sync', event, ...safe });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export async function timed(metric, labels, operation) {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    observe(metric, (performance.now() - started) / 1000, labels);
  }
}

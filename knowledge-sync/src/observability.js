const counters = new Map();
const gauges = new Map();
const histograms = new Map();
const bucketConfigs = new Map();

const DEFAULT_HISTOGRAM_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export function configureBuckets(name, buckets) {
  bucketConfigs.set(name, buckets);
}

function key(name, labels = {}) {
  const entries = Object.entries(labels).filter(([, value]) => value !== undefined && value !== null).sort(([a], [b]) => a.localeCompare(b));
  return `${name}|${entries.map(([label, value]) => `${label}=${String(value)}`).join(',')}`;
}

function parseKey(value) {
  const [name, raw = ''] = value.split('|');
  const labels = raw ? Object.fromEntries(raw.split(',').map(item => item.split('='))) : {};
  return { name, labels };
}

function labelsText(labels) {
  const entries = Object.entries(labels);
  if (!entries.length) return '';
  return `{${entries.map(([name, value]) => `${name}="${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

export function increment(name, labels = {}, value = 1) {
  const metric = key(name, labels);
  counters.set(metric, (counters.get(metric) || 0) + value);
}

export function gauge(name, value, labels = {}) {
  gauges.set(key(name, labels), Number(value) || 0);
}

export function observe(name, value, labels = {}) {
  const metric = key(name, labels);
  let current = histograms.get(metric);
  if (!current) {
    const thresholds = bucketConfigs.get(name) || DEFAULT_HISTOGRAM_BUCKETS;
    current = { count: 0, sum: 0, buckets: Object.fromEntries(thresholds.map(b => [b, 0])) };
    histograms.set(metric, current);
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
  for (const [metric, value] of counters) {
    const { name, labels } = parseKey(metric);
    lines.push(`${name}${labelsText(labels)} ${value}`);
  }
  for (const [metric, value] of gauges) {
    const { name, labels } = parseKey(metric);
    lines.push(`${name}${labelsText(labels)} ${value}`);
  }
  for (const [metric, value] of histograms) {
    const { name, labels } = parseKey(metric);
    for (const b in value.buckets) {
      lines.push(`${name}_bucket${labelsText({ ...labels, le: b })} ${value.buckets[b]}`);
    }
    lines.push(`${name}_bucket${labelsText({ ...labels, le: '+Inf' })} ${value.count}`);
    lines.push(`${name}_count${labelsText(labels)} ${value.count}`);
    lines.push(`${name}_sum${labelsText(labels)} ${value.sum}`);
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

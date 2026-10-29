const crypto = require('node:crypto');
const os = require('node:os');
const createMiddleware = require('./middleware.js');

const INGEST_PATH = '/api/v1/ingest';

// A dashboard that is down must not make an app grow without bound, so past
// this many distinct job names the rest are folded into one bucket.
const MAX_JOB_NAMES = 500;
const OVERFLOW_JOB = '(other)';

// Accepts the forms people have historically passed: `host:port`,
// `ws://host:port` (1.x trackers spoke WebSocket) and `http(s)://host/base`.
const toIngestUrl = (url) => {
  let base = String(url).trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(base)) {
    base = `http://${base}`;
  }
  const parsed = new URL(base.replace(/^ws(s?):\/\//i, 'http$1://'));
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}${INGEST_PATH}`;
  return parsed.toString();
};

const count = (n) => {
  const value = Number(n);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

const byteLength = (data) => {
  if (data === undefined || data === null) {
    return 0;
  }
  if (typeof data === 'string') {
    return Buffer.byteLength(data);
  }
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  try {
    return Buffer.byteLength(JSON.stringify(data) ?? '');
  } catch {
    // Circular or otherwise unserialisable: it was never going to be sent
    // as-is, so there is no honest size to report.
    return 0;
  }
};

const rowCount = (data) => {
  if (data === undefined || data === null) {
    return 0;
  }
  return Array.isArray(data) ? data.length : 1;
};

const emptyBatch = () => ({
  bytes: { sent: 0, received: 0 },
  rows: { read: 0, written: 0 },
  jobs: new Map(),
  jobCount: 0,
});

const addJob = (jobs, name, job) => {
  let key = String(name);
  if (!jobs.has(key) && jobs.size >= MAX_JOB_NAMES) {
    key = OVERFLOW_JOB;
  }
  const entry = jobs.get(key);
  if (!entry) {
    jobs.set(key, { ...job });
    return;
  }
  entry.count += job.count;
  entry.totalDuration += job.totalDuration;
  if (job.lastStart >= entry.lastStart) {
    entry.lastStart = job.lastStart;
    entry.lastDuration = job.lastDuration;
  }
};

// A 4xx other than these means resending the same batch can never succeed.
const RETRYABLE = new Set([408, 429]);

class Rejected extends Error {}

/**
 * Collects stats for the current process and POSTs them to a dashboard in
 * batches. Nothing here opens a connection that outlives a request, and every
 * timer is unref'd, so a cron job that uses the tracker still exits on its own.
 */
function tracker(config = {}) {
  if (!config.name) {
    throw new TypeError('stats-tracker: `name` is required');
  }

  const logger = config.logger || console;
  const { name } = config;
  // In Kubernetes the hostname is the pod name, which is what tells replicas apart.
  const pod = config.pod || os.hostname();
  const endpoint = config.url ? toIngestUrl(config.url) : null;
  const flushInterval = config.flushInterval ?? 10000;
  const timeout = config.timeout ?? 10000;
  const headers = { 'content-type': 'application/json' };
  if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }

  let batch = emptyBatch();
  // A batch the dashboard may or may not have applied: a timeout does not mean
  // the write failed. It is resent unchanged, under the same id, until it is
  // acknowledged, and the dashboard ignores an id it has already applied, so
  // nothing is counted twice.
  let unsent = null;
  const bootId = crypto.randomUUID();
  let seq = 0;
  let connected = false;
  let failing = false;
  let closed = false;
  let queue = Promise.resolve();
  let cpuSince = process.cpuUsage();
  let cpuSinceTime = process.hrtime.bigint();

  const sampleUsage = () => {
    const now = process.hrtime.bigint();
    const cpu = process.cpuUsage(cpuSince);
    const elapsedMicros = Number(now - cpuSinceTime) / 1000;
    cpuSince = process.cpuUsage();
    cpuSinceTime = now;
    const percent = elapsedMicros > 0 ? ((cpu.user + cpu.system) / elapsedMicros) * 100 : 0;
    return {
      // Can exceed 100 on more than one core, the same as `ps` and pidusage.
      cpu: Math.round(percent * 100) / 100,
      memory: process.memoryUsage.rss(),
      uptime: process.uptime(),
    };
  };

  const take = (closing) => {
    const taken = batch;
    batch = emptyBatch();
    seq += 1;
    return {
      id: `${bootId}:${seq}`,
      name,
      pod,
      closing,
      usage: sampleUsage(),
      bytes: taken.bytes,
      rows: taken.rows,
      jobCount: taken.jobCount,
      jobs: [...taken.jobs].map(([jobName, job]) => ({ name: jobName, ...job })),
    };
  };

  const post = async (body) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    // The body is unused, but leaving it unread holds the socket open.
    await res.arrayBuffer().catch(() => {});
    if (res.status >= 400 && res.status < 500 && !RETRYABLE.has(res.status)) {
      throw new Rejected(`dashboard rejected the batch: ${res.status} ${res.statusText}`);
    }
    if (!res.ok) {
      throw new Error(`dashboard answered ${res.status} ${res.statusText}`);
    }
  };

  const send = async ({ closing = false } = {}) => {
    if (!endpoint) {
      batch = emptyBatch();
      return false;
    }
    try {
      if (unsent) {
        await post(unsent);
        unsent = null;
      }
      unsent = take(closing);
      await post(unsent);
      unsent = null;
      connected = true;
      if (failing) {
        failing = false;
        logger.log(`stats-tracker: reconnected to ${endpoint}`);
      }
      return true;
    } catch (err) {
      connected = false;
      if (err instanceof Rejected) {
        // Retrying would be refused the same way (a wrong token, say) and
        // would hold up every batch after it.
        unsent = null;
        logger.error(`stats-tracker: ${err.message}; the batch was dropped`);
        return false;
      }
      if (!failing) {
        failing = true;
        logger.error(`stats-tracker: could not reach ${endpoint}, will keep retrying: ${err.message}`);
      }
      return false;
    }
  };

  const flush = (options) => {
    queue = queue.then(() => send(options));
    return queue;
  };

  const interval = setInterval(() => {
    flush();
  }, flushInterval);
  interval.unref();
  // Report once shortly after start so a new pod shows up without waiting a whole interval.
  const firstReport = setTimeout(() => {
    flush();
  }, Math.min(1000, flushInterval));
  firstReport.unref();

  const close = () => {
    if (closed) {
      return queue;
    }
    closed = true;
    clearInterval(interval);
    clearTimeout(firstReport);
    process.off('beforeExit', close);
    return flush({ closing: true });
  };

  // `beforeExit` fires when the event loop runs dry, which is how a cron job
  // ends. It is not emitted for `process.exit()` or a signal; call `close()`
  // yourself in those paths.
  process.on('beforeExit', close);

  const recordJob = (jobName, start, duration) => {
    batch.jobCount += 1;
    addJob(batch.jobs, jobName, {
      count: 1,
      totalDuration: duration,
      lastStart: start,
      lastDuration: duration,
    });
  };

  const self = {
    name,
    pod,
    enabled: Boolean(endpoint),
    isConnected: () => connected,
    flush: () => flush(),
    close,
    bytes: {
      sent: (n) => { batch.bytes.sent += count(n); },
      received: (n) => { batch.bytes.received += count(n); },
    },
    data: {
      sent: (data) => { batch.bytes.sent += byteLength(data); },
      received: (data) => { batch.bytes.received += byteLength(data); },
    },
    database: {
      read: (data) => { batch.rows.read += rowCount(data); },
      written: (data) => { batch.rows.written += rowCount(data); },
    },
    databaseRows: {
      read: (n) => { batch.rows.read += count(n); },
      written: (n) => { batch.rows.written += count(n); },
    },
    job: {
      start: (jobName, start = Date.now()) => {
        let duration = null;
        return {
          stop: () => {
            if (duration === null) {
              duration = Math.max(0, Date.now() - start);
              recordJob(jobName, start, duration);
            }
            return duration;
          },
        };
      },
    },
  };
  self.middleware = (options) => createMiddleware(self, options);
  return self;
}

module.exports = tracker;
module.exports.tracker = tracker;
module.exports.toIngestUrl = toIngestUrl;
module.exports.byteLength = byteLength;

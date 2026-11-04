const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const tracker = require('../lib/tracker.js');
const { fakeDashboard, quietLogger } = require('./helpers.js');

const make = (url, extra = {}) => tracker({
  name: 'test-app',
  pod: 'test-app-1',
  url,
  flushInterval: 60 * 60 * 1000,
  logger: quietLogger(),
  ...extra,
});

test('sends counters, rows and aggregated jobs in one batch', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url);
  t.after(() => st.close());

  st.bytes.sent(10);
  st.bytes.received(15);
  st.data.sent('héllo'); // 6 bytes in UTF-8
  st.data.received(Buffer.alloc(4));
  st.data.sent({ a: 1 }); // '{"a":1}'
  st.databaseRows.read(20);
  st.databaseRows.written(25);
  st.database.read([1, 2, 3]);
  st.database.written({ one: 'row' });
  st.job.start('sync', Date.now() - 50).stop();
  st.job.start('sync', Date.now() - 10).stop();
  st.job.start('other').stop();

  assert.equal(await st.flush(), true);
  assert.equal(st.isConnected(), true);
  assert.equal(dash.requests[0].url, '/api/v1/ingest');

  const [batch] = dash.batches;
  assert.equal(batch.name, 'test-app');
  assert.equal(batch.pod, 'test-app-1');
  assert.equal(batch.closing, false);
  assert.deepEqual(batch.bytes, { sent: 10 + 6 + 7, received: 15 + 4 });
  assert.deepEqual(batch.rows, { read: 23, written: 26 });
  assert.equal(batch.jobCount, 3);
  const sync = batch.jobs.find((j) => j.name === 'sync');
  assert.equal(sync.count, 2);
  assert.ok(sync.totalDuration >= 60);
  assert.ok(sync.lastDuration >= 10 && sync.lastDuration < 50, 'last run is the most recent start');
  assert.equal(typeof batch.usage.cpu, 'number');
  assert.ok(batch.usage.memory > 0);
  assert.ok(batch.usage.uptime > 0);

  // The batch was taken, so the next one starts from zero.
  await st.flush();
  assert.deepEqual(dash.batches[1].bytes, { sent: 0, received: 0 });
  assert.equal(dash.batches[1].jobs.length, 0);
});

test('ignores values that are not counts', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url);
  t.after(() => st.close());

  st.databaseRows.read('abc');
  st.databaseRows.read(-5);
  st.databaseRows.read(NaN);
  st.databaseRows.written('7');
  st.bytes.sent(Infinity);
  st.database.read(undefined);
  st.database.read(null);
  st.data.sent(undefined);
  const circular = {};
  circular.self = circular;
  st.data.received(circular);

  await st.flush();
  assert.deepEqual(dash.batches[0].rows, { read: 0, written: 7 });
  assert.deepEqual(dash.batches[0].bytes, { sent: 0, received: 0 });
});

test('a job stopped twice is only counted once', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url);
  t.after(() => st.close());

  const job = st.job.start('once');
  const first = job.stop();
  assert.equal(job.stop(), first);
  await st.flush();
  assert.equal(dash.batches[0].jobCount, 1);
});

test('keeps counts while the dashboard is down and sends them once it is back', async (t) => {
  const dash = await fakeDashboard({ status: 503 });
  t.after(() => dash.close());
  const logger = quietLogger();
  const st = make(dash.url, { logger });
  t.after(() => st.close());

  st.bytes.sent(100);
  st.job.start('j').stop();
  assert.equal(await st.flush(), false);
  st.bytes.sent(1);
  assert.equal(await st.flush(), false);
  assert.equal(st.isConnected(), false);
  assert.equal(logger.lines.filter(([level]) => level === 'error').length, 1, 'an outage is logged once, not on every retry');

  dash.setStatus(204);
  assert.equal(await st.flush(), true);
  // The failed batch goes first, exactly as it was, then what came after it.
  assert.equal(dash.batches.length, 2);
  assert.deepEqual(dash.batches.map((b) => b.bytes.sent), [100, 1]);
  assert.equal(dash.batches[0].jobs[0].count, 1);
  assert.equal(dash.batches[0].id, dash.requests[0].body.id, 'resent under its original id');
  assert.notEqual(dash.batches[0].id, dash.batches[1].id);
  assert.match(logger.lines.at(-1)[1], /reconnected/);
});

test('a batch that timed out is resent under the same id', async (t) => {
  // The dashboard records the batch but answers too late: from the tracker's
  // side it looks like a failure, though the counts were applied.
  const dash = await fakeDashboard({ delay: 300 });
  t.after(() => dash.close());
  const st = make(dash.url, { timeout: 100 });
  t.after(() => st.close());

  st.databaseRows.written(5);
  assert.equal(await st.flush(), false);
  dash.setDelay(0);
  assert.equal(await st.flush(), true);

  const ids = dash.batches.map((b) => b.id);
  assert.equal(ids[0], ids[1], 'a real dashboard skips the second copy by its id');
  assert.equal(dash.batches[0].rows.written, 5);
});

test('a batch the dashboard rejects is dropped instead of retried forever', async (t) => {
  const dash = await fakeDashboard({ status: 401 });
  t.after(() => dash.close());
  const logger = quietLogger();
  const st = make(dash.url, { logger });
  t.after(() => st.close());

  st.bytes.sent(1);
  assert.equal(await st.flush(), false);
  dash.setStatus(204);
  st.bytes.sent(2);
  assert.equal(await st.flush(), true);
  assert.deepEqual(dash.batches.map((b) => b.bytes.sent), [2]);
  assert.match(logger.lines[0][1], /rejected the batch: 401/);
});

test('an unreachable dashboard does not throw', async (t) => {
  const st = make('http://127.0.0.1:9', { timeout: 500 });
  t.after(() => st.close());
  st.bytes.sent(1);
  assert.equal(await st.flush(), false);
});

test('without a url the tracker is a no-op', async () => {
  const st = tracker({ name: 'off', logger: quietLogger() });
  assert.equal(st.enabled, false);
  st.bytes.sent(1);
  st.job.start('x').stop();
  assert.equal(await st.flush(), false);
  await st.close();
});

test('requires a name', () => {
  assert.throws(() => tracker({ url: 'http://x' }), /name/);
});

test('sends the ingest token when one is configured', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url, { token: 's3cret' });
  t.after(() => st.close());
  await st.flush();
  assert.equal(dash.requests[0].headers.authorization, 'Bearer s3cret');
});

test('sends no authorization header without a token', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url);
  t.after(() => st.close());
  await st.flush();
  assert.equal(dash.requests[0].headers.authorization, undefined);
});

test('close sends a final closing batch and stops listening for beforeExit', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const before = process.listenerCount('beforeExit');
  const st = make(dash.url);
  assert.equal(process.listenerCount('beforeExit'), before + 1);
  st.databaseRows.written(3);
  await st.close();
  await st.close();
  assert.equal(process.listenerCount('beforeExit'), before);
  assert.equal(dash.batches.length, 1);
  assert.equal(dash.batches[0].closing, true);
  assert.equal(dash.batches[0].rows.written, 3);
});

test('folds job names past the limit into one bucket', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const st = make(dash.url);
  t.after(() => st.close());
  for (let i = 0; i < 600; i += 1) {
    st.job.start(`job-${i}`).stop();
  }
  await st.flush();
  const { jobs, jobCount } = dash.batches[0];
  assert.equal(jobCount, 600);
  assert.equal(jobs.length, 501);
  assert.equal(jobs.find((j) => j.name === '(other)').count, 100);
});

test('normalises the dashboard url', () => {
  assert.equal(tracker.toIngestUrl('localhost:3000'), 'http://localhost:3000/api/v1/ingest');
  assert.equal(tracker.toIngestUrl('ws://dash:3001'), 'http://dash:3001/api/v1/ingest');
  assert.equal(tracker.toIngestUrl('wss://dash'), 'https://dash/api/v1/ingest');
  assert.equal(tracker.toIngestUrl('https://host/base/'), 'https://host/base/api/v1/ingest');
});

test('a cron-style process exits on its own and reports before it does', async (t) => {
  const dash = await fakeDashboard();
  t.after(() => dash.close());
  const script = `
    const tracker = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'tracker.js'))});
    const st = tracker({ name: 'cron', pod: 'cron-1', url: ${JSON.stringify(dash.url)}, flushInterval: 10000 });
    const job = st.job.start('nightly');
    setTimeout(() => { st.databaseRows.written(42); job.stop(); }, 50);
  `;
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('process did not exit')); }, 8000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 5000, 'timers must not hold the process open');
  const last = dash.batches.at(-1);
  assert.equal(last.closing, true);
  const total = dash.batches.reduce((sum, b) => sum + b.rows.written, 0);
  assert.equal(total, 42);
  assert.equal(dash.batches.flatMap((b) => b.jobs).find((j) => j.name === 'nightly').count, 1);
});

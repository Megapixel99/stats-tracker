// End to end against a real MongoDB. Skipped unless MONGO_URL is set, e.g.
//   docker run -d -p 27017:27017 mongo:8
//   MONGO_URL=mongodb://127.0.0.1:27017 npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const tracker = require('../lib/tracker.js');
const dashboard = require('../lib/dashboard.js');
const { connect } = require('../database/connection.js');
const { quietLogger } = require('./helpers.js');

const skip = !process.env.MONGO_URL && 'MONGO_URL is not set';
let dash;
let base;

before(async () => {
  if (skip) return;
  const url = new URL(process.env.MONGO_URL);
  url.pathname = `/tallyboard_test_${process.pid}`;
  dash = dashboard({
    port: 0,
    mongoUrl: url.toString(),
    token: 'ingest-token',
    timezone: 'America/Los_Angeles',
    usageLength: 3,
    logger: quietLogger(),
  });
  await new Promise((resolve) => { dash.server.once('listening', resolve); });
  await dash.ready;
  base = `http://127.0.0.1:${dash.server.address().port}`;
});

after(async () => {
  if (skip) return;
  await dash.connection.dropDatabase();
  await dash.close();
});

const make = (pod) => tracker({
  name: 'e2e-app', pod, url: base, token: 'ingest-token', flushInterval: 3600000, logger: quietLogger(),
});

test('replicas add up, and the dashboard renders what they sent', { skip }, async () => {
  assert.equal(dash.isReady(), true);
  const a = make('e2e-app-a');
  const b = make('e2e-app-b');

  // Both replicas report the same day at the same moment.
  for (let i = 0; i < 5; i += 1) {
    a.bytes.sent(100);
    b.bytes.sent(1);
    a.databaseRows.read(2);
    a.job.start('GET /items/:id', Date.now() - 20).stop();
    b.job.start('GET /items/:id', Date.now() - 40).stop();
    // eslint-disable-next-line no-await-in-loop
    assert.deepEqual(await Promise.all([a.flush(), b.flush()]), [true, true]);
  }

  const stats = await fetch(`${base}/stats`).then((r) => r.json());
  const row = stats.serverStats.find((s) => s.name === 'e2e-app');
  assert.deepEqual(row.pods.map((p) => p.name), ['e2e-app-a', 'e2e-app-b']);
  assert.equal(row.bytesSent, '505 Bytes');
  assert.equal(stats.database.read.day, '10');
  assert.equal(stats.utilized.day, '10');
  assert.equal(stats.periods.day.totals.jobs, 10);
  assert.equal(stats.periods.year.buckets.length, 12);
  assert.equal(row.periods.week.totals.sent, 505);
  assert.equal(row.periods.week.jobs.at(-1), 10);

  const pod = await dash.models.server.findOne({ pod: 'e2e-app-a' }).lean();
  assert.equal(pod.usage.length, 3, 'usage history is capped at usageLength');
  assert.equal(await dash.models.stats.countDocuments({ server: 'e2e-app' }), 1, 'one document per app per day');

  const jobs = await fetch(`${base}/server/e2e-app/jobs`).then((r) => r.json());
  assert.equal(jobs.jobs.length, 1);
  assert.equal(jobs.jobs[0].name, 'GET /items/:id');
  assert.equal(jobs.jobs[0].num, 10);
  assert.ok(jobs.jobs[0].averageTime >= 20);
  assert.equal(jobs.jobs[0].periods.day.runs, 10);
  assert.deepEqual(jobs.pods.map((p) => p.name), ['e2e-app-a', 'e2e-app-b']);

  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.match(html, /e2e-app/);
  assert.match(html, /2 pods running/);
  assert.match(html, /<title>Tallyboard<\/title>/);
  // Pods are listed on the app's own page.
  const page = await fetch(`${base}/server/e2e-app`).then((r) => r.text());
  assert.match(page, /GET \/items\/:id/);
  assert.match(page, /e2e-app-a/);
  assert.match(page, /<title>e2e-app · Tallyboard<\/title>/);
  for (const asset of ['tallyboard.css', 'tallyboard.js', 'favicon.svg']) {
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await fetch(`${base}/assets/${asset}`)).status, 200, asset);
  }

  // A replica that shuts down cleanly disappears from the pod list at once,
  // but what it reported stays in the totals.
  await b.close();
  const remaining = (await fetch(`${base}/stats`).then((r) => r.json()))
    .serverStats.find((s) => s.name === 'e2e-app');
  assert.deepEqual(remaining.pods.map((p) => p.name), ['e2e-app-a']);
  assert.equal(remaining.bytesSent, '505 Bytes');
  await a.close();

  // With no pods left the app is still listed, because cron jobs look like this between runs.
  const idle = await fetch(`${base}/stats`).then((r) => r.json());
  assert.deepEqual(idle.serverStats.find((s) => s.name === 'e2e-app').pods, []);
  assert.equal((await fetch(`${base}/server/e2e-app`, { redirect: 'manual' })).status, 200);
});

test('the ingest endpoint checks the token and the batch', { skip }, async () => {
  const post = (body, token = 'ingest-token') => fetch(`${base}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ name: 'x' }, 'wrong')).status, 401);
  assert.equal((await post({ name: '' })).status, 400);
  assert.equal((await post({ name: 'x', pod: 'x-1' })).status, 204);
});

test('the same batch sent twice is counted once', { skip }, async () => {
  const body = {
    id: 'boot-abc:1', name: 'dup-app', pod: 'dup-app-1', rows: { read: 9 }, jobCount: 1,
  };
  const post = () => fetch(`${base}/api/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ingest-token' },
    body: JSON.stringify(body),
  });
  assert.equal((await post()).status, 204);
  assert.equal((await post()).status, 204, 'the tracker must see success, or it would keep resending');
  const day = await dash.models.stats.findOne({ server: 'dup-app' }).lean();
  assert.equal(day.databaseRows.read, 9);
  assert.equal(day.jobCount, 1);

  // A closing batch that is resent is also only counted once.
  body.id = 'boot-abc:2';
  body.closing = true;
  await post();
  await post();
  const again = await dash.models.stats.findOne({ server: 'dup-app' }).lean();
  assert.equal(again.databaseRows.read, 18);
  const pod = await dash.models.server.findOne({ pod: 'dup-app-1' }).lean();
  assert.equal(pod.active, false);
});

test('names are escaped in the rendered page', { skip }, async () => {
  const evil = tracker({
    name: '<img src=x onerror=alert(1)>', url: base, token: 'ingest-token', flushInterval: 3600000, logger: quietLogger(),
  });
  await evil.flush();
  const html = await fetch(`${base}/`).then((r) => r.text());
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
  await evil.close();
});

test('?period picks what the figures cover, and ?fragment returns just the content', { skip }, async () => {
  const text = (path) => fetch(`${base}${path}`).then((r) => r.text());

  const week = await text('/?period=week');
  assert.match(week, /<html/);
  assert.match(week, /<div class="content" data-period="week">/);
  assert.match(week, /aria-current="true">Past week</);

  const fragment = await text('/?period=month&fragment=1');
  assert.doesNotMatch(fragment, /<html|<head/);
  assert.match(fragment, /<div class="content" data-period="month">/);

  // Anything else falls back to today rather than failing.
  assert.match(await text('/?period=__proto__'), /data-period="day"/);

  const app = await text('/server/e2e-app?period=year&fragment=1');
  assert.match(app, /data-period="year"/);
  assert.match(app, /GET \/items\/:id/);
});

test('an unknown server redirects home and its jobs 404, as in 1.x', { skip }, async () => {
  assert.equal((await fetch(`${base}/server/nope`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${base}/server/nope/jobs`)).status, 404);
});

test('pods that stop reporting are marked inactive and later removed', { skip }, async () => {
  const { models } = dash;
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  await models.server.create([
    {
      server: 'stale', pod: 'stale-1', active: true, lastSeen: fiveMinutesAgo,
    },
    {
      server: 'stale', pod: 'stale-2', active: false, lastSeen: old,
    },
  ]);
  await dash.sweep();
  const left = await models.server.find({ server: 'stale' }).lean();
  assert.deepEqual(left.map((p) => [p.pod, p.active]), [['stale-1', false]]);
});

test('a dashboard started while MongoDB is unreachable keeps trying', { skip }, async () => {
  const logger = quietLogger();
  // Nothing listens on port 9, so the first attempt fails fast.
  const db = connect('mongodb://127.0.0.1:9/never', logger, {
    retryDelay: 50,
    serverSelectionTimeoutMS: 100,
  });
  db.opened.catch(() => {});
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  await db.close();
  const retries = logger.lines.filter(([, line]) => /retrying/.test(line));
  assert.ok(retries.length >= 2, `expected repeated attempts, saw ${retries.length}`);
});

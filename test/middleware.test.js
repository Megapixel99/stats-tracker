const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express5 = require('express');
const express4 = require('express4');
const tracker = require('../lib/tracker.js');
const { fakeDashboard, quietLogger } = require('./helpers.js');

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); }),
  };
};

// Waits for the response to finish on the server side, then for the
// tracker's 'finish' listener, which runs after the client has its bytes.
const settle = () => new Promise((resolve) => { setTimeout(resolve, 20); });

const setup = async (t) => {
  const dash = await fakeDashboard();
  const st = tracker({
    name: 'web', pod: 'web-1', url: dash.url, flushInterval: 3600000, logger: quietLogger(),
  });
  t.after(async () => { await st.close(); await dash.close(); });
  const report = async () => {
    await settle();
    await st.flush();
    return dash.batches.at(-1);
  };
  return { st, report };
};

const expressApp = (express, st) => {
  const app = express();
  app.use(st.middleware({ skip: (req) => req.path.startsWith('/_health') }));
  app.use(express.json());
  app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));
  app.post('/users', (req, res) => res.status(201).send('created'));
  app.get('/_health/liveness', (req, res) => res.send('ok'));
  const api = express.Router();
  api.get('/items/:item', (req, res) => res.send('item'));
  app.use('/api/v1', api);
  return app;
};

[['Express 4', express4], ['Express 5', express5]].forEach(([label, express]) => {
  test(`${label}: names jobs by route and counts real body bytes`, async (t) => {
    const { st, report } = await setup(t);
    const srv = await listen(expressApp(express, st));
    t.after(() => srv.close());

    const a = await fetch(`${srv.url}/users/123?verbose=1`).then((r) => r.text());
    const b = await fetch(`${srv.url}/users/456`).then((r) => r.text());
    const body = JSON.stringify({ name: 'Freddy' });
    await fetch(`${srv.url}/users`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    await fetch(`${srv.url}/api/v1/items/9`).then((r) => r.text());
    await fetch(`${srv.url}/no/such/path/1`).then((r) => r.text());
    await fetch(`${srv.url}/no/such/path/2`).then((r) => r.text());
    await fetch(`${srv.url}/_health/liveness`).then((r) => r.text());

    const batch = await report();
    const names = Object.fromEntries(batch.jobs.map((j) => [j.name, j.count]));
    assert.deepEqual(names, {
      'GET /users/:id': 2,
      'POST /users': 1,
      'GET /api/v1/items/:item': 1,
      'GET (unmatched)': 2,
    });
    assert.equal(batch.jobCount, 6, 'the skipped health check is not counted');
    assert.equal(batch.bytes.received, Buffer.byteLength(body));
    // Every response body, including both 404 pages, but nothing for the health check.
    assert.ok(batch.bytes.sent >= a.length + b.length + 'created'.length + 'item'.length);
  });
});

test('Express 5: res.json and res.send are not double counted', async (t) => {
  const { st, report } = await setup(t);
  const app = express5();
  app.use(st.middleware());
  const payload = { list: Array.from({ length: 100 }, (_, i) => i) };
  app.get('/json', (req, res) => res.json(payload));
  app.get('/send-object', (req, res) => res.send(payload));
  const srv = await listen(app);
  t.after(() => srv.close());

  const one = await fetch(`${srv.url}/json`).then((r) => r.text());
  const two = await fetch(`${srv.url}/send-object`).then((r) => r.text());
  const batch = await report();
  assert.equal(batch.bytes.sent, Buffer.byteLength(one) + Buffer.byteLength(two));
});

test('bare node http with streamed writes', async (t) => {
  const { st, report } = await setup(t);
  const mw = st.middleware();
  const srv = await listen((req, res) => mw(req, res, () => {
    res.write('abc');
    res.write(Buffer.from('defg'));
    res.end('hi', 'utf8');
  }));
  t.after(() => srv.close());

  await fetch(`${srv.url}/stream?x=1`).then((r) => r.text());
  const batch = await report();
  assert.equal(batch.bytes.sent, 9);
  assert.deepEqual(batch.jobs.map((j) => j.name), ['GET /stream']);
});

test('a client that hangs up is still counted once', async (t) => {
  const { st, report } = await setup(t);
  const app = express5();
  app.use(st.middleware());
  app.get('/slow', () => {});
  const srv = await listen(app);
  t.after(() => srv.close());

  const controller = new AbortController();
  const pending = fetch(`${srv.url}/slow`, { signal: controller.signal }).catch(() => {});
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  controller.abort();
  await pending;
  const batch = await report();
  assert.equal(batch.jobCount, 1);
});

test('a custom name function', async (t) => {
  const { st, report } = await setup(t);
  const app = express5();
  app.use(st.middleware({ name: (req) => `custom:${req.method}` }));
  app.get('/x', (req, res) => res.send('x'));
  const srv = await listen(app);
  t.after(() => srv.close());

  await fetch(`${srv.url}/x`).then((r) => r.text());
  assert.deepEqual((await report()).jobs.map((j) => j.name), ['custom:GET']);
});

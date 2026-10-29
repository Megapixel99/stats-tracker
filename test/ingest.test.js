const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { ingest, parseBatch, InvalidBatch } = require('../routers/ingest.js');

// Records what would be written instead of talking to MongoDB.
const fakeModels = ({ seen = [] } = {}) => {
  const calls = [];
  const op = (model, method) => (...args) => {
    calls.push({ model, method, args });
    // What the unique { server, pod } index does to an upsert whose
    // `lastBatch: { $ne: id }` filter matched nothing because the id was seen.
    if (model === 'server' && seen.includes(args[0].lastBatch?.$ne)) {
      return Promise.reject(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    }
    return Promise.resolve();
  };
  return {
    calls,
    server: { updateOne: op('server', 'updateOne'), deleteOne: op('server', 'deleteOne') },
    stats: { updateOne: op('stats', 'updateOne') },
    jobs: { bulkWrite: op('jobs', 'bulkWrite') },
  };
};

const batch = (extra = {}) => ({
  name: 'app',
  pod: 'app-1',
  usage: { cpu: 1.5, memory: 1000, uptime: 12 },
  bytes: { sent: 10, received: 0 },
  rows: { read: 0, written: 3 },
  jobCount: 2,
  jobs: [{
    name: 'GET /x', count: 2, totalDuration: 30, lastStart: Date.now(), lastDuration: 10,
  }],
  ...extra,
});

test('one batch is at most three writes, all of them increments', async () => {
  const models = fakeModels();
  await ingest(models, batch(), { usageLength: 5, timezone: 'America/Los_Angeles' });

  assert.deepEqual(models.calls.map((c) => `${c.model}.${c.method}`), [
    'server.updateOne', 'stats.updateOne', 'jobs.bulkWrite',
  ]);

  const [server, stats, jobs] = models.calls;
  assert.deepEqual(server.args[0], { server: 'app', pod: 'app-1' });
  assert.equal(server.args[1].$set.active, true);
  assert.equal(server.args[1].$push.usage.$slice, -5);
  assert.deepEqual(server.args[2], { upsert: true });

  assert.deepEqual(stats.args[1], {
    $inc: { 'bytes.sent': 10, 'databaseRows.written': 3, jobCount: 2 },
  });
  // Days are counted from midnight in the dashboard's timezone, not UTC.
  const midnight = DateTime.fromJSDate(stats.args[0].date).setZone('America/Los_Angeles');
  assert.equal(midnight.toFormat('HH:mm:ss'), '00:00:00');

  const [write] = jobs.args[0];
  assert.deepEqual(write.updateOne.filter.name, 'GET /x');
  assert.deepEqual(write.updateOne.update.$inc, { count: 2, totalDuration: 30 });
  assert.equal(write.updateOne.upsert, true);
});

test('a heartbeat with nothing to count only touches the pod', async () => {
  const models = fakeModels();
  await ingest(models, batch({
    bytes: {}, rows: {}, jobCount: 0, jobs: [],
  }));
  assert.deepEqual(models.calls.map((c) => c.model), ['server']);
});

test('a closing batch marks the pod inactive but still keeps its last counts', async () => {
  const models = fakeModels();
  await ingest(models, batch({ closing: true }));
  assert.deepEqual(models.calls.map((c) => `${c.model}.${c.method}`), [
    'server.updateOne', 'stats.updateOne', 'jobs.bulkWrite',
  ]);
  assert.equal(models.calls[0].args[1].$set.active, false);
  assert.equal(models.calls[0].args[1].$push, undefined);
});

test('a batch whose id was already applied writes nothing else', async () => {
  const models = fakeModels({ seen: ['boot:7'] });
  const result = await ingest(models, batch({ id: 'boot:7' }));
  assert.equal(result.duplicate, true);
  assert.deepEqual(models.calls.map((c) => c.model), ['server']);

  const fresh = fakeModels({ seen: ['boot:7'] });
  await ingest(fresh, batch({ id: 'boot:8' }));
  assert.equal(fresh.calls[0].args[1].$set.lastBatch, 'boot:8');
  assert.deepEqual(fresh.calls.map((c) => c.model), ['server', 'stats', 'jobs']);
});

test('rejects batches that would write garbage', () => {
  assert.throws(() => parseBatch(null), InvalidBatch);
  assert.throws(() => parseBatch({}), InvalidBatch);
  assert.throws(() => parseBatch({ name: '' }), InvalidBatch);
  assert.throws(() => parseBatch({ name: 'x'.repeat(201) }), InvalidBatch);
  assert.throws(() => parseBatch({ name: 'a', jobs: [{ name: 5 }] }), InvalidBatch);
  const tooMany = new Array(1001).fill({ name: 'j', count: 1 });
  assert.throws(() => parseBatch({ name: 'a', jobs: tooMany }), InvalidBatch);
});

test('coerces numbers instead of handing strings to $inc', () => {
  const parsed = parseBatch({
    name: 'a',
    bytes: { sent: 'abc', received: '5' },
    rows: { read: -1, written: Infinity },
    jobs: [{ name: 'j', count: 0 }],
  });
  assert.deepEqual(parsed.bytes, { sent: 0, received: 5 });
  assert.deepEqual(parsed.rows, { read: 0, written: 0 });
  assert.equal(parsed.pod, 'a', 'pod defaults to the name, as it did in 1.x');
  assert.equal(parsed.jobs.length, 0, 'a job that never ran is dropped');
});

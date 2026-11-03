const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
  formatBytes, formatSeconds, formatNum, summarize,
} = require('../functions/index.js');

test('formats bytes, seconds and numbers', () => {
  assert.equal(formatBytes(0), '0 Bytes');
  assert.equal(formatBytes(1500), '1.5 KB');
  assert.equal(formatBytes(2e30), '2000000 YB');
  assert.equal(formatSeconds(1234), '1.234 Seconds');
  assert.equal(formatSeconds(0), '0 Seconds');
  assert.equal(formatNum(1234567), '1,234,567');
  assert.equal(globalThis.nfObject, undefined, 'formatNum no longer leaks a global');
});

test('summarize buckets day documents into day, week, month and year', () => {
  const now = DateTime.fromISO('2026-10-29T12:00:00', { zone: 'America/Los_Angeles' });
  const day = (d) => now.minus({ days: d }).startOf('day').toJSDate();
  const doc = (d, n) => ({
    date: day(d),
    bytes: { sent: n, received: n },
    databaseRows: { read: n, written: 0 },
    jobCount: n,
  });
  const stats = [doc(0, 1), doc(3, 10), doc(20, 100), doc(200, 1000), doc(400, 10000)];
  const s = summarize(stats, now);
  assert.deepEqual(s.database.read, {
    day: '1', week: '11', month: '111', year: '1,111',
  });
  assert.deepEqual(s.utilized, {
    day: '1', week: '11', month: '111', year: '1,111',
  });
  assert.equal(s.bytes.synced.year, '2.22 KB');
});

test('loading the tracker entry point never touches the dashboard dependencies', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('../index.js'))}).tracker({ name: 'x' }).close();
    console.log(Object.keys(require.cache).filter((k) => k.includes('node_modules')).length);
  `]).toString().trim();
  assert.equal(out, '0');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const {
  formatBytes, formatSeconds, formatNum, formatCompact, formatDuration, formatUptime, formatAgo,
  formatDay, periodOf, summarize,
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

test('each period has its total and a 12-bucket trend at its own granularity', () => {
  const now = DateTime.fromISO('2026-11-03T13:00:00', { zone: 'America/Los_Angeles' });
  const day = (d) => now.minus({ days: d }).startOf('day').toJSDate();
  const doc = (d, n) => ({
    date: day(d),
    bytes: { sent: n, received: 0 },
    databaseRows: { read: n, written: 0 },
    jobCount: n,
  });
  const { periods } = summarize(
    [doc(0, 1), doc(1, 2), doc(6, 4), doc(7, 8), doc(40, 16), doc(364, 32), doc(366, 64)],
    now,
  );

  assert.deepEqual(periods.day.buckets.map((b) => b.jobs), [0, 0, 0, 0, 8, 4, 0, 0, 0, 0, 2, 1]);
  assert.deepEqual(periods.week.buckets.slice(-2).map((b) => b.jobs), [8, 7]);
  assert.deepEqual(['day', 'week', 'month', 'year'].map((p) => periods[p].totals.jobs), [1, 7, 15, 63]);
  // The newest bucket of a short period is the period itself.
  ['day', 'week', 'month'].forEach((p) => {
    assert.equal(periods[p].buckets.at(-1).jobs, periods[p].totals.jobs, p);
  });
  // Only the buckets inside the period are drawn in the accent.
  assert.deepEqual(
    ['day', 'week', 'month', 'year'].map((p) => periods[p].buckets.filter((b) => b.current).length),
    [1, 1, 1, 12],
  );
  assert.equal(periods.day.buckets.at(-1).label, 'Tue, Nov 3');
  assert.equal(periods.month.buckets.at(-1).label, 'Oct 4 – Nov 3');
  assert.equal(periods.month.buckets[0].label, 'Nov 4 – Dec 3, 2025');
});

test('formats compact figures, durations, uptimes, days and ages', () => {
  assert.equal(formatCompact(1284), '1,284');
  assert.equal(formatCompact(12940), '12.9K');
  assert.equal(formatCompact(5143820), '5.1M');
  assert.equal(formatDuration(82.4), '82 ms');
  assert.equal(formatDuration(1420), '1.42 s');
  assert.equal(formatDuration(45000), '45 s');
  assert.equal(formatDuration(125000), '2 min 5 s');
  assert.equal(formatUptime(42), '42 s');
  assert.equal(formatUptime(200000), '2 d 7 h');

  const zone = 'America/Los_Angeles';
  const now = DateTime.fromISO('2026-11-03T13:00:00', { zone });
  const ago = (days) => now.minus({ days }).toJSDate();
  assert.deepEqual([0, 1, 10, 400].map((d) => formatDay(ago(d), zone, now)), [
    'today', 'yesterday', 'Oct 24', 'Sep 29, 2025',
  ]);
  const at = now.toJSDate();
  assert.equal(formatAgo(new Date(at - 2000), at), 'just now');
  assert.equal(formatAgo(new Date(at - 90000), at), '1 min ago');

  assert.equal(periodOf('week'), 'week');
  assert.equal(periodOf('__proto__'), 'day');
  assert.equal(periodOf(undefined), 'day');
});

test('loading the tracker entry point never touches the dashboard dependencies', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    require(${JSON.stringify(require.resolve('../index.js'))}).tracker({ name: 'x' }).close();
    console.log(Object.keys(require.cache).filter((k) => k.includes('node_modules')).length);
  `]).toString().trim();
  assert.equal(out, '0');
});

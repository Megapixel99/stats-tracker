const { DateTime } = require('luxon');

const numberFormat = new Intl.NumberFormat('en-US');
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes';

  const k = 1000;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);

  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
};

// Takes milliseconds, which is what job durations are recorded in.
const formatSeconds = (ms, decimals = 3) => {
  if (!+ms) return '0 Seconds';

  const dm = decimals < 0 ? 0 : decimals;

  return `${parseFloat((ms / 1000).toFixed(dm))} Seconds`;
};

const formatNum = (num) => numberFormat.format(num);

// 1,284 stays as it is; 12,940 becomes 12.9K. For figures read at a glance.
const formatCompact = (num) => (Math.abs(num) < 10000 ? formatNum(num) : compactFormat.format(num));

// A job duration in the unit that reads best: 82 ms, 1.4 s, 2 min 5 s.
const formatDuration = (ms) => {
  if (!+ms) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60 * 1000) return `${parseFloat((ms / 1000).toFixed(ms < 10000 ? 2 : 1))} s`;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min ${Math.round((ms % 60000) / 1000)} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

// How long a pod has been up, from the seconds it reports.
const formatUptime = (seconds) => {
  const s = Math.max(0, Math.floor(+seconds || 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h`;
};

const formatAgo = (date, now = new Date()) => {
  if (!date) return '';
  const s = Math.max(0, Math.round((now - new Date(date)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

// A day as people say it: today, yesterday, Oct 25, or Oct 25, 2025.
const formatDay = (date, zone = 'UTC', now = DateTime.now()) => {
  if (!date) return '';
  const day = DateTime.fromJSDate(new Date(date)).setZone(zone).startOf('day');
  const today = now.setZone(zone).startOf('day');
  if (+day === +today) return 'today';
  if (+day === +today.minus({ days: 1 })) return 'yesterday';
  return day.toFormat(day.year === today.year ? 'LLL d' : 'LLL d, yyyy');
};

const average = (values) => (values.length > 0
  ? values.reduce((a, b) => a + b, 0) / values.length
  : 0);

// The periods the dashboard can show. Each is a rolling window ending now,
// with a 12-bucket trend at the granularity that suits it.
const PERIODS = {
  day: {
    label: 'Today', unit: 'days', bucket: 'days', every: 'Daily, last 12 days',
  },
  week: {
    label: 'Past week', unit: 'weeks', bucket: 'weeks', every: 'Weekly, last 12 weeks',
  },
  month: {
    label: 'Past month', unit: 'months', bucket: 'months', every: 'Monthly, last 12 months',
  },
  year: {
    label: 'Past year', unit: 'years', bucket: 'months', every: 'Monthly, last 12 months',
  },
};
const BUCKETS = 12;

const periodOf = (value) => (Object.hasOwn(PERIODS, value) ? value : 'day');

const blank = () => ({
  jobs: 0, sent: 0, received: 0, read: 0, written: 0,
});

/* eslint-disable no-param-reassign */
const add = (into, stat) => {
  into.jobs += stat.jobCount || 0;
  into.sent += stat.bytes?.sent || 0;
  into.received += stat.bytes?.received || 0;
  into.read += stat.databaseRows?.read || 0;
  into.written += stat.databaseRows?.written || 0;
};
/* eslint-enable no-param-reassign */

// Day documents are dated at the start of their day, so a bucket holds the
// days that start inside it; its label names the first and last of them, and
// the year once it is not this one.
const bucketLabel = (from, to, unit, thisYear) => {
  const start = from.startOf('day');
  const first = start < from ? start.plus({ days: 1 }) : start;
  const last = to.minus({ milliseconds: 1 }).startOf('day');
  const year = last.year === thisYear ? '' : `, ${last.year}`;
  return unit === 'days'
    ? `${first.toFormat('ccc, LLL d')}${year}`
    : `${first.toFormat('LLL d')} – ${last.toFormat('LLL d')}${year}`;
};

// Where the 12 buckets of each period start and end, and which one is still
// in progress (the newest). The same for every app, so worked out once.
const periodEdges = (now) => Object.fromEntries(Object.entries(PERIODS).map(([key, period]) => {
  const since = now.minus({ [period.unit]: 1 }).toMillis();
  const edges = Array.from({ length: BUCKETS + 1 }, (_, k) => now.minus({ [period.bucket]: BUCKETS - k }));
  return [key, {
    since,
    edges: edges.map((e) => e.toMillis()),
    buckets: edges.slice(0, BUCKETS).map((from, i) => ({
      label: bucketLabel(from, edges[i + 1], period.bucket, now.year),
      current: i === BUCKETS - 1,
    })),
  }];
}));

// Totals for each period, and each period's buckets oldest first.
const periodTotals = (stats, edgesByPeriod) => Object.fromEntries(
  Object.entries(edgesByPeriod).map(([key, { since, edges }]) => {
    const totals = blank();
    const buckets = Array.from({ length: BUCKETS }, blank);
    stats.forEach((stat) => {
      const at = stat.date.getTime();
      if (at >= since) add(totals, stat);
      if (at < edges[0] || at >= edges[BUCKETS]) return;
      const i = edges.findIndex((edge, n) => at >= edge && at < edges[n + 1]);
      add(buckets[i], stat);
    });
    return [key, { totals, buckets }];
  }),
);

// Everything the header figures show, for each period, from the day documents.
const summarize = (stats, now) => {
  const edges = periodEdges(now);
  const totals = periodTotals(stats, edges);

  const pick = (fn) => Object.fromEntries(
    Object.keys(PERIODS).map((key) => [key, fn(totals[key].totals)]),
  );
  return {
    database: {
      read: pick((t) => formatNum(t.read)),
      written: pick((t) => formatNum(t.written)),
    },
    utilized: pick((t) => formatNum(t.jobs)),
    bytes: {
      synced: pick((t) => formatBytes(t.sent + t.received)),
    },
    periods: Object.fromEntries(Object.entries(PERIODS).map(([key, period]) => [key, {
      label: period.label,
      every: period.every,
      totals: totals[key].totals,
      buckets: edges[key].buckets.map((bucket, i) => ({ ...bucket, ...totals[key].buckets[i] })),
    }])),
  };
};

const podSummary = (pod) => {
  const usage = pod.usage || [];
  const latest = usage.at(-1);
  const memoryUsage = latest ? latest.memoryUsage : 0;
  return {
    name: pod.pod,
    active: pod.active !== false,
    lastSeen: pod.lastSeen,
    uptime: pod.uptime || 0,
    cpuUsage: latest ? latest.cpuUsage.toFixed(2) : 0,
    memoryUsage,
    formatedMemoryUsage: formatBytes(memoryUsage),
    avgCpuUsage: average(usage.map((u) => u.cpuUsage)),
    avgMemoryUsage: average(usage.map((u) => u.memoryUsage)),
  };
};

/**
 * Every application with a running pod, plus those that reported in the last
 * `recentDays` days. Cron jobs have no pod between runs, and leaving them off
 * the list would hide most of what the dashboard tracks.
 */
async function serverStats(models, { timezone = 'UTC', recentDays = 7 } = {}) {
  const now = DateTime.now().setZone(timezone);
  const since = now.minus({ years: 1 }).startOf('day').toJSDate();
  const recent = now.minus({ days: recentDays }).startOf('day').toJSDate();

  const [pods, stats, totals] = await Promise.all([
    models.server.find({ active: true }).sort({ server: 1, pod: 1 }).lean(),
    models.stats.find({ date: { $gte: since } }).lean(),
    models.stats.aggregate([{
      $group: {
        _id: '$server',
        sent: { $sum: '$bytes.sent' },
        received: { $sum: '$bytes.received' },
      },
    }]),
  ]);

  const names = new Set(pods.map((p) => p.server));
  stats.filter((s) => s.date >= recent).forEach((s) => names.add(s.server));
  const totalsByServer = new Map(totals.map((t) => [t._id, t]));
  const statsByServer = new Map();
  stats.forEach((s) => statsByServer.set(s.server, [...(statsByServer.get(s.server) || []), s]));
  const edges = periodEdges(now);

  const servers = [...names].sort().map((name) => {
    const own = statsByServer.get(name) || [];
    const periods = periodTotals(own, edges);
    return {
      name,
      pods: pods.filter((p) => p.server === name).map(podSummary),
      bytesSent: formatBytes(totalsByServer.get(name)?.sent || 0),
      bytesReceived: formatBytes(totalsByServer.get(name)?.received || 0),
      lastActive: own.reduce((latest, s) => (!latest || s.date > latest ? s.date : latest), null),
      periods: Object.fromEntries(Object.entries(periods).map(([key, p]) => [key, {
        totals: p.totals,
        jobs: p.buckets.map((b) => b.jobs),
      }])),
    };
  });

  return {
    serverStats: servers,
    ...summarize(stats, now),
  };
}

async function serverJobs(models, serverName, { timezone = 'UTC' } = {}) {
  const now = DateTime.now().setZone(timezone);
  const since = now.minus({ years: 1 }).startOf('day').toJSDate();
  // Runs and time spent within each period, so the job list follows the
  // period picked like everything else on the page.
  const windows = Object.entries(PERIODS).map(([key, period]) => [
    key, now.minus({ [period.unit]: 1 }).toJSDate(),
  ]);
  const within = (from, field) => ({ $sum: { $cond: [{ $gte: ['$date', from] }, field, 0] } });

  const [stats, jobs, pods] = await Promise.all([
    models.stats.find({ server: serverName, date: { $gte: since } }).lean(),
    models.jobs.aggregate([
      { $match: { server: serverName, date: { $gte: since } } },
      { $sort: { lastStart: 1 } },
      {
        $group: {
          _id: '$name',
          num: { $sum: '$count' },
          totalDuration: { $sum: '$totalDuration' },
          lastRan: { $last: '$lastStart' },
          lastRanTime: { $last: '$lastDuration' },
          ...Object.fromEntries(windows.flatMap(([key, from]) => [
            [`${key}Runs`, within(from, '$count')],
            [`${key}Duration`, within(from, '$totalDuration')],
          ])),
        },
      },
      { $sort: { _id: 1 } },
    ]),
    models.server.find({ server: serverName }).sort({ active: -1, pod: 1 }).lean(),
  ]);

  if (stats.length === 0 && jobs.length === 0 && pods.length === 0) {
    return null;
  }

  return {
    name: serverName,
    ...summarize(stats, now),
    lastActive: stats.reduce((latest, s) => (!latest || s.date > latest ? s.date : latest), null),
    pods: pods.map(podSummary),
    jobs: jobs.map((job) => ({
      name: job._id,
      num: job.num,
      averageTime: job.num > 0 ? job.totalDuration / job.num : 0,
      lastRanTime: job.lastRanTime,
      formatedLastRanTime: formatSeconds(job.lastRanTime),
      lastRanAt: job.lastRan || null,
      lastRan: job.lastRan
        ? DateTime.fromJSDate(job.lastRan)
          .setZone(timezone)
          .toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS)
        : '',
      periods: Object.fromEntries(windows.map(([key]) => {
        const runs = job[`${key}Runs`];
        return [key, { runs, averageTime: runs > 0 ? job[`${key}Duration`] / runs : 0 }];
      })),
    })),
  };
}

module.exports = {
  PERIODS,
  periodOf,
  formatBytes,
  formatSeconds,
  formatNum,
  formatCompact,
  formatDuration,
  formatUptime,
  formatAgo,
  formatDay,
  summarize,
  serverStats,
  serverJobs,
};

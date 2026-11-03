const { DateTime } = require('luxon');

const numberFormat = new Intl.NumberFormat('en-US');

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

const average = (values) => (values.length > 0
  ? values.reduce((a, b) => a + b, 0) / values.length
  : 0);

const WINDOWS = {
  day: 'days',
  week: 'weeks',
  month: 'months',
  year: 'years',
};

// Everything the header cards show, for each window, in one pass over the
// day documents instead of the sixteen filters it used to take.
const summarize = (stats, now) => {
  const totals = Object.fromEntries(Object.entries(WINDOWS).map(([key, unit]) => [key, {
    since: now.minus({ [unit]: 1 }).toJSDate(),
    read: 0,
    written: 0,
    jobs: 0,
    synced: 0,
  }]));

  stats.forEach((stat) => {
    Object.values(totals).forEach((total) => {
      if (stat.date >= total.since) {
        /* eslint-disable no-param-reassign */
        total.read += stat.databaseRows?.read || 0;
        total.written += stat.databaseRows?.written || 0;
        total.jobs += stat.jobCount || 0;
        total.synced += (stat.bytes?.sent || 0) + (stat.bytes?.received || 0);
        /* eslint-enable no-param-reassign */
      }
    });
  });

  const pick = (fn) => Object.fromEntries(
    Object.keys(WINDOWS).map((key) => [key, fn(totals[key])]),
  );
  return {
    database: {
      read: pick((t) => formatNum(t.read)),
      written: pick((t) => formatNum(t.written)),
    },
    utilized: pick((t) => formatNum(t.jobs)),
    bytes: {
      synced: pick((t) => formatBytes(t.synced)),
    },
  };
};

const podSummary = (pod) => {
  const usage = pod.usage || [];
  const latest = usage.at(-1);
  const memoryUsage = latest ? latest.memoryUsage : 0;
  return {
    name: pod.pod,
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

  const servers = [...names].sort().map((name) => ({
    name,
    pods: pods.filter((p) => p.server === name).map(podSummary),
    bytesSent: formatBytes(totalsByServer.get(name)?.sent || 0),
    bytesReceived: formatBytes(totalsByServer.get(name)?.received || 0),
  }));

  return {
    serverStats: servers,
    ...summarize(stats, now),
  };
}

async function serverJobs(models, serverName, { timezone = 'UTC' } = {}) {
  const now = DateTime.now().setZone(timezone);
  const since = now.minus({ years: 1 }).startOf('day').toJSDate();

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
        },
      },
      { $sort: { _id: 1 } },
    ]),
    models.server.countDocuments({ server: serverName }),
  ]);

  if (stats.length === 0 && jobs.length === 0 && pods === 0) {
    return null;
  }

  return {
    name: serverName,
    ...summarize(stats, now),
    jobs: jobs.map((job) => ({
      name: job._id,
      num: job.num,
      averageTime: job.num > 0 ? job.totalDuration / job.num : 0,
      lastRanTime: job.lastRanTime,
      formatedLastRanTime: formatSeconds(job.lastRanTime),
      lastRan: job.lastRan
        ? DateTime.fromJSDate(job.lastRan)
          .setZone(timezone)
          .toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS)
        : '',
    })),
  };
}

module.exports = {
  formatBytes,
  formatSeconds,
  formatNum,
  summarize,
  serverStats,
  serverJobs,
};

const { DateTime } = require('luxon');
const models = require('../database/models.js');

const formatBytes = (bytes, decimals = 2) => {
  if (!+bytes) return '0 Bytes'

  const k = 1000
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`
};

const formatSeconds = (seconds, decimals = 3) => {
  if (!+seconds) return '0 Seconds'

  const dm = decimals < 0 ? 0 : decimals

  return `${parseFloat((seconds / 1000).toFixed(dm))} Seconds`
};

const formatNum = (num) => {
  nfObject = new Intl.NumberFormat('en-US');
  return nfObject.format(num);
}

const parseKeyStr = (obj, str) => {
  if (str.split('.').length > 1) {
    let k = str.split('.')[0];
    return parseKeyStr(obj[k], str.split('.').slice(1).join('.'));
  }
  return obj[str];
}

const reduceValFromArr = (arr, val) => {
  if (arr.length === 0) {
    return 0;
  }
  return arr.map((e) => parseKeyStr(e, val)).reduce((a, b) => a + b, 0);
}

const filterStatsByStartOf = (stats, str) => {
  let duration = {};
  duration[str] = 1;
  return stats.filter((e) => DateTime.fromJSDate(e.date) >= DateTime.now().minus(duration));
}

module.exports = {
  formatBytes,
  formatSeconds,
  serverStats: async () => {
    const serverPods = (await models.server.find({ active: true }).lean());
    const stats = (await models.stats.find().lean());
    let servers = [];
    serverPods.forEach((pod) => {
      let s = servers.find((e) => e.name === pod.server);
      if (!s) {
        servers.push({
          name: pod.server,
          pods: [pod],
        });
      } else {
        s.pods.push(pod);
      }
    });
    let serverStats = servers.map((e) => {
      let statArr = stats.filter((i) => i.server === e.name);
      if (statArr) {
        return {
          name: e.name,
          pods: e.pods.map((o) => {
            let m = o.usage.map((i) => i.memoryUsage);
            let c = o.usage.map((i) => i.cpuUsage);
            let memoryUsage = o.usage.length >= 1 ? o.usage.at(-1).memoryUsage : 0;
            return {
              name: o.pod,
              cpuUsage: o.usage.length >= 1 ? o.usage.at(-1).cpuUsage.toFixed(2) : 0,
              memoryUsage,
              formatedMemoryUsage: formatBytes(memoryUsage),
              avgCpuUsage: c.length >= 1 ? c.reduce((a, b) => a + b) / c.length : 0,
              avgMemoryUsage: m.length >= 1 ? m.reduce((a, b) => a + b) / m.length : 0,
            };
          }),
          bytesSent: formatBytes(reduceValFromArr(statArr, 'bytes.sent')),
          bytesReceived: formatBytes(reduceValFromArr(statArr, 'bytes.received')),
        };
      }
      return null;
    }).filter((e) => e);

    return {
      serverStats,
      database: {
        read: {
          day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'databaseRows.read')),
          week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'databaseRows.read')),
          month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'databaseRows.read')),
          year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'databaseRows.read')),
        },
        written: {
          day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'databaseRows.written')),
          week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'databaseRows.written')),
          month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'databaseRows.written')),
          year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'databaseRows.written')),
        },
      },
      utilized: {
        day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'jobs.length')),
        week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'jobs.length')),
        month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'jobs.length')),
        year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'jobs.length')),
      },
      bytes: {
        synced: {
          day: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'bytes.sent')),
          week: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'bytes.sent')),
          month: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'bytes.sent')),
          year: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'bytes.sent')),
        },
      },
    };
  },
  serverJobs: async (serverName) => {
    const server = (await models.server.findOne({ server: serverName, active: true }).lean());
    const stats = (await models.stats.find({ server: serverName }).lean());
    if (!(server && stats)) {
      return false;
    }
    let jobs = [];
    stats.map((s) => s.jobs).flat().forEach((e) => {
      let j = jobs.find((i) => i.name === e.name);
      let isLastRun = (lastRan) => new Date(lastRan).getMilliseconds() > new Date(e.start).getMilliseconds();
      if (j) {
        j.num += 1;
        j.lastRan = isLastRun(j.lastRan) ? j.lastRan : e.start;
        j.averageTime.push(e.duration);
        j.lastRanTime = isLastRun(j.lastRan) ? j.lastRanTime : e.duration;
      } else {
        jobs.push({
          lastRan: e.start,
          averageTime: [e.duration],
          lastRanTime: e.duration,
          formatedLastRanTime: formatSeconds(e.duration),
          num: 1,
          name: e.name,
        });
      }
    });
    return {
      name: serverName,
      utilized: stats.map((s) => s.jobs).length,
      database: {
        read: {
          day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'databaseRows.read')),
          week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'databaseRows.read')),
          month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'databaseRows.read')),
          year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'databaseRows.read')),
        },
        written: {
          day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'databaseRows.written')),
          week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'databaseRows.written')),
          month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'databaseRows.written')),
          year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'databaseRows.written')),
        },
      },
      utilized: {
        day: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'jobs.length')),
        week: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'jobs.length')),
        month: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'jobs.length')),
        year: formatNum(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'jobs.length')),
      },
      bytes: {
        synced: {
          day: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'days'), 'bytes.sent')),
          week: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'weeks'), 'bytes.sent')),
          month: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'months'), 'bytes.sent')),
          year: formatBytes(reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'bytes.received') + reduceValFromArr(filterStatsByStartOf(stats, 'years'), 'bytes.sent')),
        },
      },
      jobs: jobs.map((e) => ({
        ...e,
        averageTime: e.averageTime.reduce((a, b) => a + b) / e.num,
      })),
    }
  }
};

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
      let s = stats.find((i) => i.server === e.name);
      if (s) {
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
          bytesSent: formatBytes(s.bytes.sent),
          bytesReceived: formatBytes(s.bytes.received),
        };
      }
      return null;
    }).filter((e) => e);

    return {
      serverStats,
      database: {
        read: stats.map((e) => e.databaseRows.read).reduce((a, b) => a + b, 0),
        written: stats.map((e) => e.databaseRows.written).reduce((a, b) => a + b, 0),
      },
      bytes: {
        sent: formatBytes(stats.map((e) => e.bytes.sent).reduce((a, b) => a + b, 0)),
        received: formatBytes(stats.map((e) => e.bytes.received).reduce((a, b) => a + b, 0)),
      },
    };
  },
  serverJobs: async (serverName) => {
    const server = (await models.server.findOne({ server: serverName, active: true }).lean());
    const stats = (await models.stats.findOne({ server: serverName }).lean());
    if (!(server && stats)) {
      return false;
    }
    let jobs = [];
    stats.jobs.forEach((e) => {
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
      utilized: stats.jobs.length,
      database: stats.databaseRows,
      bytes: {
        sent: formatBytes(stats.bytes.sent),
        received: formatBytes(stats.bytes.received),
      },
      jobs: jobs.map((e) => ({
        ...e,
        averageTime: e.averageTime.reduce((a, b) => a + b) / e.num,
      })),
    }
  }
};

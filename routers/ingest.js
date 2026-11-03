const crypto = require('node:crypto');
const express = require('express');
const { DateTime } = require('luxon');

const MAX_NAME = 200;
const MAX_JOBS = 1000;

class InvalidBatch extends Error {}

const text = (value, field, max = MAX_NAME) => {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new InvalidBatch(`\`${field}\` must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
};

const amount = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const parseBatch = (body) => {
  if (!body || typeof body !== 'object') {
    throw new InvalidBatch('expected a JSON object');
  }
  const jobs = Array.isArray(body.jobs) ? body.jobs : [];
  if (jobs.length > MAX_JOBS) {
    throw new InvalidBatch(`at most ${MAX_JOBS} job names per batch`);
  }
  return {
    id: body.id === undefined ? null : text(body.id, 'id', 100),
    server: text(body.name, 'name'),
    pod: text(body.pod ?? body.name, 'pod', 253),
    closing: body.closing === true,
    usage: body.usage && typeof body.usage === 'object' ? {
      cpu: amount(body.usage.cpu),
      memory: amount(body.usage.memory),
      uptime: amount(body.usage.uptime),
    } : null,
    bytes: { sent: amount(body.bytes?.sent), received: amount(body.bytes?.received) },
    rows: { read: amount(body.rows?.read), written: amount(body.rows?.written) },
    jobCount: amount(body.jobCount),
    jobs: jobs.map((job, i) => ({
      name: text(job?.name, `jobs[${i}].name`),
      count: amount(job.count),
      totalDuration: amount(job.totalDuration),
      lastStart: new Date(amount(job.lastStart) || Date.now()),
      lastDuration: amount(job.lastDuration),
    })).filter((job) => job.count > 0),
  };
};

const DUPLICATE_KEY = 11000;

/**
 * Applies one tracker batch with at most three writes to MongoDB, no matter
 * how many requests or jobs the batch covers.
 *
 * The pod's document records the id of the last batch applied, and is
 * claimed before anything is counted: a tracker that timed out resends the
 * same batch, and the claim is how the second copy is recognised and skipped.
 * The cost is that if MongoDB fails between the claim and the counts, that
 * one batch is lost rather than counted twice.
 */
async function ingest(models, body, { usageLength = 100, timezone = 'UTC' } = {}) {
  const batch = parseBatch(body);
  const now = new Date();
  const day = DateTime.now().setZone(timezone).startOf('day').toJSDate();
  const pod = { server: batch.server, pod: batch.pod };

  // A pod that shut down is only marked inactive, not deleted, so that its
  // `lastBatch` is still there if the closing batch is resent. The sweeper
  // removes it later.
  const claim = { $set: { active: !batch.closing, lastSeen: now } };
  if (batch.id) {
    claim.$set.lastBatch = batch.id;
  }
  if (batch.usage && !batch.closing) {
    claim.$set.uptime = batch.usage.uptime;
    claim.$push = {
      usage: {
        $each: [{ date: now, cpuUsage: batch.usage.cpu, memoryUsage: batch.usage.memory }],
        $slice: -Math.max(1, Math.abs(Number(usageLength)) || 100),
      },
    };
  }
  try {
    // When the id matches, the filter finds nothing and the upsert tries to
    // insert a second document for the pod, which the unique index refuses.
    const filter = batch.id ? { ...pod, lastBatch: { $ne: batch.id } } : pod;
    await models.server.updateOne(filter, claim, { upsert: true });
  } catch (err) {
    if (batch.id && err.code === DUPLICATE_KEY) {
      return { ...batch, duplicate: true };
    }
    throw err;
  }

  const writes = [];

  const inc = {};
  const add = (field, value) => {
    if (value > 0) {
      inc[field] = value;
    }
  };
  add('bytes.sent', batch.bytes.sent);
  add('bytes.received', batch.bytes.received);
  add('databaseRows.read', batch.rows.read);
  add('databaseRows.written', batch.rows.written);
  add('jobCount', batch.jobCount || batch.jobs.reduce((sum, job) => sum + job.count, 0));
  if (Object.keys(inc).length > 0) {
    writes.push(models.stats.updateOne(
      { server: batch.server, date: day },
      { $inc: inc },
      { upsert: true },
    ));
  }

  if (batch.jobs.length > 0) {
    writes.push(models.jobs.bulkWrite(batch.jobs.map((job) => ({
      updateOne: {
        filter: { server: batch.server, date: day, name: job.name },
        update: {
          $inc: { count: job.count, totalDuration: job.totalDuration },
          $max: { lastStart: job.lastStart },
          // Last writer wins, so with several replicas this is the duration
          // of a recent run rather than strictly the latest one.
          $set: { lastDuration: job.lastDuration },
        },
        upsert: true,
      },
    })), { ordered: false }));
  }

  await Promise.all(writes);
  return batch;
}

const tokenMatches = (header, token) => {
  const given = Buffer.from(String(header || ''));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
};

function ingestRouter(models, config) {
  const router = express.Router();

  router.post('/api/v1/ingest', express.json({ limit: '1mb' }), async (req, res, next) => {
    if (config.token && !tokenMatches(req.headers.authorization, config.token)) {
      res.status(401).json({ status: 401, message: 'Unauthorized' });
      return;
    }
    try {
      await ingest(models, req.body, config);
      res.sendStatus(204);
    } catch (err) {
      if (err instanceof InvalidBatch) {
        res.status(400).json({ status: 400, message: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

module.exports = {
  ingest,
  ingestRouter,
  parseBatch,
  InvalidBatch,
};

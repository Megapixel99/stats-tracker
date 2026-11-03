const path = require('node:path');

// These are not dependencies of the package, so that an app which only
// reports stats installs none of them; check for them before anything else
// fails with a bare "Cannot find module".
const NEEDS = ['express', 'ejs', 'express-ejs-layouts', 'luxon', 'mongoose'];
const missing = NEEDS.filter((name) => {
  try {
    require.resolve(name);
    return false;
  } catch {
    return true;
  }
});
if (missing.length > 0) {
  throw new Error(`tallyboard: the dashboard needs ${missing.join(', ')}. Install them where it runs: npm install ${NEEDS.join(' ')}`);
}
// eslint-disable-next-line import/no-extraneous-dependencies
const expressMajor = Number(require('express/package.json').version.split('.')[0]);
if (expressMajor < 5) {
  throw new Error(`tallyboard: the dashboard needs Express 5 or newer, found ${expressMajor}`);
}

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const clientRouter = require('../routers/client.js');
const { ingestRouter } = require('../routers/ingest.js');
const { connect, isConnected } = require('../database/connection.js');
const createModels = require('../database/models.js');

const root = path.join(__dirname, '..');

/**
 * Serves the dashboard and the endpoint trackers report to. Returns the
 * Express app so the caller can add routes (health checks, auth) of its own.
 */
function dashboard(config = {}) {
  const settings = {
    port: 3000,
    usageLength: 100,
    timezone: 'UTC',
    // A pod that has not reported for this long is shown as gone.
    inactiveAfter: 60 * 1000,
    // And is forgotten entirely after this long.
    removeAfter: 24 * 60 * 60 * 1000,
    recentDays: 7,
    listen: true,
    ...config,
    logger: config.logger || console,
  };
  const { logger } = settings;

  if (!settings.mongoUrl) {
    throw new TypeError('tallyboard: `mongoUrl` is required');
  }

  const db = connect(settings.mongoUrl, logger);
  const { connection } = db;
  const models = createModels(connection);

  // Not ready until the indexes exist: the unique ones are what make
  // concurrent upserts and resent batches safe, and the first writes to a
  // new database otherwise wait seconds behind the index builds.
  let indexed = false;
  const ready = db.opened
    .then(() => Promise.all(Object.values(models).map((model) => model.init())))
    .then(() => {
      indexed = true;
    });
  ready.catch((err) => logger.error(`tallyboard: could not prepare MongoDB: ${err.message}`));

  const sweep = async () => {
    const now = Date.now();
    try {
      await models.server.updateMany(
        { active: true, lastSeen: { $lt: new Date(now - settings.inactiveAfter) } },
        { $set: { active: false } },
      );
      await models.server.deleteMany({
        active: false,
        lastSeen: { $lt: new Date(now - settings.removeAfter) },
      });
    } catch (err) {
      logger.error(`tallyboard: could not sweep inactive pods: ${err.message}`);
    }
  };
  const sweeper = setInterval(sweep, Math.min(30 * 1000, settings.inactiveAfter));
  sweeper.unref();

  const app = express();

  app.set('json spaces', 2);
  app.set('views', path.join(root, 'views'));
  app.set('view engine', 'ejs');
  app.use(expressLayouts);

  app.use(express.static(path.join(root, 'public')));

  app.get('/ping', (req, res) => {
    res.status(200).send('pong');
  });

  app.use(ingestRouter(models, settings));
  app.use(clientRouter(models, settings));

  let server = null;
  if (settings.listen) {
    server = app.listen(settings.port, () => {
      logger.log(`tallyboard: dashboard listening on port ${server.address().port}`);
    });
  }

  return {
    app,
    // Kept for 1.x callers.
    expressServer: app,
    server,
    models,
    connection,
    // Resolves once MongoDB is connected and indexed.
    ready,
    isReady: () => indexed && isConnected(connection),
    sweep,
    appSetInactive: (name) => models.server
      .updateMany({ server: name }, { $set: { active: false } })
      .exec(),
    close: async () => {
      clearInterval(sweeper);
      if (server) {
        await new Promise((resolve) => { server.close(() => resolve()); });
      }
      await db.close();
    },
  };
}

module.exports = dashboard;
module.exports.dashboard = dashboard;

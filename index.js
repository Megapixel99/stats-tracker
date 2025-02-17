const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const client = require('./routers/client.js');
const WS = require('./routers/webSocket.js');
const dbConn = require('./database/connection.js');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');
const pidusage = require('pidusage');
var nodeCleanup = require('node-cleanup');
const { serialize } = require('v8')
const models = require('./database/models.js');
const { DateTime, Settings } = require('luxon');

module.exports = {
  tracker: (config) => {

    if (!config.logger) {
      config.logger = console;
    }

    if (config.timezone) {
      Settings.defaultZoneName = config.timezone;
    }

    let ws;

    const isConnected = () => ws?._readyState === WebSocket.OPEN;

    let memInterval = null;
    let connectInterval = null;

    function connect() {
      if (config.url.startsWith('ws://')) {
        ws = new WebSocket(config.url);
      } else {
        ws = new WebSocket(`ws://${config.url}`);
      }

      ws.on('error', (err) => {
        if (!err.code === 'ECONNREFUSED') {
          config.logger.error(err);
        }
      });

      ws.on('open', (conn) => {
        if (isConnected()) {
          clearInterval(connectInterval);

          let memCheck = () => pidusage(process.pid).then((stats) => {
            ws.send(JSON.stringify({
              type: 'memory',
              ...config,
              ...stats,
            }));
          })

          memInterval = setInterval(memCheck, 10000);

          memCheck();

          ws.on('close', () => {
            ws = null
            if (memInterval) {
              clearInterval(memInterval);
              memInterval = null;
            }
            connectInterval = setInterval(connect, 1000)
          });
        }
      });
    }

    connectInterval = setInterval(connect, 1000)

    process.on('exit', () => {
      if (isConnected()) {
        ws.send(JSON.stringify({
          type: 'app.close',
          ...config,
        }));
      }
    });

    return {
      isConnected,
      bytes: {
        sent: (data) =>
          isConnected() && !Number.isNaN(data) ? ws.send(JSON.stringify({
            type: 'bytes.sent',
            ...config,
            bytes: data,
          })) : null,
        received: (data) =>
          isConnected() && !Number.isNaN(data) ? ws.send(JSON.stringify({
            type: 'bytes.received',
            ...config,
            bytes: data,
          })) : null,
      },
      data: {
        sent: (data) =>
          isConnected() ? ws.send(JSON.stringify({
            type: 'bytes.sent',
            ...config,
            bytes: serialize(data).byteLength,
          })) : null,
        received: (data) =>
          isConnected() ? ws.send(JSON.stringify({
            type: 'bytes.received',
            ...config,
            bytes:serialize(data).byteLength,
          })) : null,
      },
      database: {
        read: (data) =>
          isConnected() ? ws.send(JSON.stringify({
            type: 'database.read',
            ...config,
            rows: [data].flat(1).length,
          })) : null,
        written: (data) =>
          isConnected() ? ws.send(JSON.stringify({
            type: 'database.written',
            ...config,
            rows: [data].flat(1).length,
          })) : null,
      },
      databaseRows: {
        read: (data) =>
          isConnected() && !Number.isNaN(data) ? ws.send(JSON.stringify({
            type: 'database.read',
            ...config,
            rows: data,
          })) : null,
        written: (data) =>
          isConnected() && !Number.isNaN(data) ? ws.send(JSON.stringify({
            type: 'database.written',
            ...config,
            rows: data,
          })) : null,
      },
      job: {
        start: (jobName, start = Date.now()) => {
          return {
            stop: () =>
              isConnected() ? ws.send(JSON.stringify({
                type: 'job',
                ...config,
                start,
                jobName,
                duration: Date.now() - start
              })) : null,
          };
        }
      }
    };
  },
  dashboard: (config) => {
    if (!config.logger) {
      config.logger = console;
    }

    dbConn.connect(config.mongoUrl, config.logger);

    setInterval(function inter() {
      const conditions = { active: true, $expr: { $lte: [{ $last: "$usage.date" }, DateTime.now().minus({ minutes: 1 }).toJSDate()] } };
      return models.server.updateMany(conditions, {
        $set: {
          active: false,
        }
      }).exec();
    }, 60000);

    const app = express();

    let listening = [];

    app.set('json spaces', 2);
    app.set('views', `${__dirname}/views`);

    app.use(express.json());
    app.set('view engine', 'ejs');
    app.use(expressLayouts);

    app.use("/", express.static(`${__dirname}/public`));

    app.use(client);

    app.get('/ping', (req, res) => {
      res.status(200).send('pong');
    });

    let wss = new WebSocketServer({ server: app.listen((config.port || 3000)) });

    wss.on('connection', (ws) => {
      ws.on('error', config.logger.error);
      new WS(ws, config.usageLength, config.logger);
    });

    config.logger.log('Dashboard is ready');

    return {
      appSetInactive(name) {
        models.server.findOneAndUpdate({ server: name }, {
          $set: {
            active: false,
          }
        }).exec();
      },
      expressServer: app,
    };
  }
};

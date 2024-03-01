const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const client = require('./routers/client.js');
const WS = require('./routers/webSocket.js');
const dbConn = require('./database/connection.js');
const { WebSocketServer } = require('ws');
const pidusage = require('pidusage');
var nodeCleanup = require('node-cleanup');
const { serialize } = require('v8')

module.exports = {
  tracker: (config) => {
    let wss;

    if (config.server) {
      wss = new WebSocketServer({ server: config.server });
    } else {
      wss = new WebSocketServer({ port: config.port });
    }

    if (!config.logger) {
      config.logger = console;
    }

    delete config.port;

    let ws = null;
    let interval = null;

    const isConnected = () =>  ws ? true : false;

    wss.on('connection', (webSock) => {
      ws = webSock;

      ws.on('error', config.logger.error);

      nodeCleanup(function (exitCode, signal) {
        ws.send(JSON.stringify({
          type: 'app.close',
          ...config,
        }));
        setTimeout(() => process.exit(0), 1000);
        return false;
      });

      interval = setInterval(function inter() {
        pidusage(process.pid).then((stats) => {
          ws.send(JSON.stringify({
            type: 'memory',
            ...config,
            ...stats,
          }));
        })
      }, 10000);
    });

    wss.on('close', function close() {
      ws = null;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    });

    createInterval = setInterval(function inter() {
      if (isConnected()) {
        clearInterval(createInterval);
        ws.send(JSON.stringify({
          type: 'create',
          ...config,
        }));
      }
    }, 1000);


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

    const app = express();

    let listening = [];

    app.set('json spaces', 2);
    app.set('views', `${__dirname}/views`);

    app.use(express.json());
    app.set('view engine', 'ejs');
    app.use(expressLayouts);

    app.use("/", express.static(`${__dirname}/public`));

    app.use(require('helmet')());

    app.use(client);

    app.get('/ping', (req, res) => {
      res.status(200).send('pong');
    });

    const updateUrls = (urls) => {
      if (Array.isArray(urls)) {
        if (urls.length > 0) {
          let oldLength = listening.length;
          let usageLength = config.usageLength;
          if ([undefined, null].includes(usageLength) || Number.isNaN(usageLength)) {
            usageLength = 100;
          }

          Promise.all(urls.filter((url) => !listening.includes(url)).map((url) => new WS(url, usageLength, config.logger)))
          .then((urlArr) => listening.push(...(urlArr.filter((e) => e.connected === true))))
          .then(() => {
            if ((listening.length - oldLength) > 0) {
              config.logger.log(`Listening to ${listening.length - oldLength} new urls`);
            }
          });
        } else {
          config.logger.log('No urls found');
        }
      } else {
        throw new Error('updateUrls accepts an array');
      }
    }

    updateUrls(config.urls);

    app.listen((config.port || 3000));

    config.logger.log('Dashboard is ready');

    return {
      updateUrls,
      expressServer: app,
    };
  }
};

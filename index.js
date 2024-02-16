const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const client = require('./routers/client.js');
const configureWebSocket = require('./routers/webSocket.js');
const dbConn = require('./database/connection.js');
const { WebSocketServer } = require('ws');
const pidusage = require('pidusage');
var nodeCleanup = require('node-cleanup');
const { serialize } = require('v8')

module.exports = {
  tracker: (config, logger = console) => {
    const wss = new WebSocketServer({ port: config.port });

    delete config.port;

    let ws = null;
    let interval = null;

    const isConnected = () =>  ws ? true : false;

    wss.on('connection', (webSock) => {
      ws = webSock;

      ws.on('error', logger.error);

      nodeCleanup(function (exitCode, signal) {
        ws.send(JSON.stringify({
          type: 'app.close',
          ...config,
        }));
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
  dashboard: (config, logger = console) => {
    dbConn.connect(config.mongoUrl);

    const app = express();

    app.set('json spaces', 2);
    app.use(require('helmet')());

    app.use(express.json());
    app.set('view engine', 'ejs');
    app.use(expressLayouts);

    app.use('/css', express.static('./public/css'))
    app.use('/js', express.static('./public/js'))
    app.use('/vendor', express.static('./public/vendor'))

    app.use(client);

    app.get('/ping', (req, res) => {
      res.status(200).send('pong');
    });

    if (config.urls.length > 0) {
      let usageLength = config.usageLength;
      if ([undefined, null].includes(config.usageLength) || Number.isNaN(config.usageLength)) {
        usageLength = 100;
      }
      config.urls.forEach((url) => {
        configureWebSocket(url, usageLength);
      });
    }

    app.listen(config.port);

    logger.log('Dashboard is ready');
  }
};

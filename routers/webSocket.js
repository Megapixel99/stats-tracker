const models = require('../database/models.js');
const WebSocket = require('ws');

class WS {
  constructor(wsUrl, usageLength, logger = console) {
    this.reconnectInterval;
    this.url = wsUrl;
    this.failedAttempts = 0;
    this.connected = false;

    return this.connect(wsUrl, usageLength, logger = console);
  }

  connect (wsUrl, usageLength, logger = console) {
    let ws;
    if (this.url.startsWith('ws://')) {
      ws = new WebSocket(this.url);
    } else {
      ws = new WebSocket(`ws://${this.url}`);
    }

    ws.on('open', () => {
      clearInterval(this.reconnectInterval);
      logger.log(`Connected to ${this.url}`);
      this.connected = true;
      this.handleConnection(ws, usageLength);
    });
    ws.on('error', (err) => this.errFunc(err, logger));
    return  new Promise((resolve, reject) => {
      let t;
      let int = setInterval(() => {
        if (this.connected === true) {
          clearInterval(int);
          clearTimeout(t);
          resolve({
            url: this.url,
            connected: this.connected,
          });
        }
      }, 1000);
      t = setTimeout(() => {
        clearInterval(int);
        resolve({
          url: this.url,
          connected: this.connected,
        });
      }, 60 * 1000);
    });
  }

  errFunc (err, logger = console) {
    this.failedAttempts += 1;
    logger.error(err);
    if (this.failedAttempts >= 5) {
      clearInterval(this.reconnectInterval);
      logger.log(`Unable to connect to ${url} after ${this.failedAttempts} attempts`);
    }
  };

  handleConnection(ws, usageLength, logger = console) {
    this.failedAttempts = 0;
    ws.on('error', (err) => this.errFunc(err, logger));

    ws.on('message', async (data) => {
      let jsonData = JSON.parse(data);
      let conditions = {
        server: jsonData.name,
        pod: (jsonData.pod || jsonData.name),
        active: true,
      };
      switch (jsonData.type) {
        case 'create':
          const server = (await models.server.findOne(conditions).lean());
          const stats = (await models.stats.findOne({ server: jsonData.name }).lean());
          let p = [];
          if (!server) {
            p.push(new models.server({
              ...conditions,
              usage: [{
                date: new Date(),
                cpuUsage: 0,
                memoryUsage: 0,
              }],
              uptime: 0,
            })
            .save());
          }
          if (!stats) {
            p.push(new models.stats({
              ...conditions,
              date: new Date(),
              bytes: {
                sent: 0,
                received: 0,
              },
              databaseRows: {
                read: 0,
                written: 0,
              },
              jobs: [],
            })
            .save());
          }
          await Promise.all(p);
          break;
        case 'memory':
          if (conditions) {
            models.server.findOneAndUpdate(conditions, {
             $set: {
               uptime: jsonData.elapsed / 1000,
             },
             $push: {
               usage: {
                 $each: [{
                   date: new Date(),
                   cpuUsage: jsonData.cpu,
                   memoryUsage: jsonData.memory,
                 }],
                $slice: Math.abs(usageLength) * -1
              }
             }
           }).exec();
          }
          break;
        case 'bytes.received':
          if (conditions) {
            models.stats.findOneAndUpdate(conditions, {
              $inc: {
                'bytes.received': jsonData.bytes,
              }
            }).exec();
          }
          break;
        case 'bytes.sent':
          if (conditions) {
            models.stats.findOneAndUpdate(conditions, {
              $inc: {
                'bytes.sent': jsonData.bytes,
              }
            }).exec();
          }
          break;
        case 'database.written':
          if (!Number.isNaN(jsonData.rows) && conditions) {
            models.stats.findOneAndUpdate(conditions, {
              $inc: {
                'databaseRows.written': jsonData.rows,
              }
            }).exec();
          }
          break;
        case 'database.read':
          if (!Number.isNaN(jsonData.rows) && conditions) {
            models.stats.findOneAndUpdate(conditions, {
              $inc: {
                'databaseRows.read': jsonData.rows,
              }
            }).exec();
          }
          break;
        case 'job':
          if (conditions) {
            let update = {};
            update.$push = {
              jobs: {
                name: jsonData.jobName,
                start: jsonData.start,
                duration: jsonData.duration,
              }
            };
            models.stats.findOneAndUpdate(conditions, update).exec();
          }
          break;
        case 'app.close':
          if (conditions) {
            models.server.findOneAndUpdate(conditions, {
              $set: {
                active: false,
              }
            }).exec();
          }
          break;
      }
    });

    ws.on('close', () => {
      this.reconnectInterval = setInterval(() => {
        this.connected = false;
        logger.log(`Disconnected from ${this.url}`);
        this.connect(this.url, usageLength, logger);
      }, 10000);
    });
  };
}

module.exports = WS;

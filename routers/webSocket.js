const models = require('../database/models.js');
const WebSocket = require('ws');
const { DateTime } = require('luxon');

class WS {
  constructor(ws, usageLength = 100, logger = console) {
    this.failedAttempts = 0;
    this.connected = true;
    this.name;
    this.pod;

    return this.handleConnection(ws, usageLength);
  }

  handleConnection(ws, usageLength, logger = console) {
    this.failedAttempts = 0;
    ws.on('error', (err) => this.errFunc(err, logger));

    ws.on('message', async (data) => {
      let jsonData = JSON.parse(data);
      this.name = jsonData.name;
      this.pod = (jsonData.pod || jsonData.name);
      let conditions = {
        server: this.name,
        pod: this.pod,
      };
      let dayStart = DateTime.now().startOf('day').toJSDate();
      switch (jsonData.type) {
        case 'create':
          const server = (await models.server.findOne(conditions).lean());
          const stats = (await models.stats.findOne({ server: jsonData.name, date: dayStart }).lean());
          let p = [];
          this.name = jsonData.name;
          if (!server) {
            p.push(new models.server({
              ...conditions,
              active: true,
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
              date: dayStart,
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
          if (this.name) {
            models.stats.findOneAndUpdate({ server: this.name, date: dayStart }, {
              $inc: {
                'bytes.received': jsonData.bytes,
              }
            }).exec();
          }
          break;
        case 'bytes.sent':
          if (this.name) {
            models.stats.findOneAndUpdate({ server: this.name, date: dayStart }, {
              $inc: {
                'bytes.sent': jsonData.bytes,
              }
            }).exec();
          }
          break;
        case 'database.written':
          if (!Number.isNaN(jsonData.rows) && conditions) {
            models.stats.findOneAndUpdate({ server: this.name, date: dayStart }, {
              $inc: {
                'databaseRows.written': jsonData.rows,
              }
            }).exec();
          }
          break;
        case 'database.read':
          if (!Number.isNaN(jsonData.rows) && conditions) {
            models.stats.findOneAndUpdate({ server: this.name, date: dayStart }, {
              $inc: {
                'databaseRows.read': jsonData.rows,
              }
            }).exec();
          }
          break;
        case 'job':
          if (this.name) {
            let update = {};
            update.$push = {
              jobs: {
                name: jsonData.jobName,
                start: jsonData.start,
                duration: jsonData.duration,
              }
            };
            models.stats.findOneAndUpdate({ server: this.name, date: dayStart }, update).exec();
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
      models.server.findOneAndUpdate({
        server: this.name,
        pod: this.pod,
      }, {
       $set: {
         active: false,
       },
      }).exec();
    });
  };
}

module.exports = WS;

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
      console.log(jsonData.type);
      this.name = jsonData.name;
      this.pod = (jsonData.pod || jsonData.name);
      let conditions = {
        server: this.name,
        pod: this.pod,
      };
      let dayStart = DateTime.now().startOf('day').toJSDate();
      if (jsonData.type === 'create') {
        const server = (await models.server.findOne(conditions).lean());
        const stats = (await models.stats.findOne({ server: jsonData.name, date: dayStart }).lean());
        let p = [];
        this.name = jsonData.name;
        if (!server) {
          p.push(new models.server({ ...conditions, active: true }).save());
        } else {
          let update = {
            $set: {
              active: true,
            }
          };
          p.push(models.server.findOneAndUpdate(conditions, update).exec());
        }
        if (!stats) {
          p.push(new models.stats({ ...conditions, date: dayStart }).save());
        }
        await Promise.all(p);
      }
      else if (jsonData.type === 'memory') {
        await models.server.findOneAndUpdate(conditions, {
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
     } else if (jsonData.type === 'app.close') {
       await models.server.findOneAndUpdate(conditions, {
         $set: {
           active: false,
         }
       }).exec();
     } else {
        const searchCond = { server: this.name, date: dayStart };
        const stats = await models.stats.find(searchCond).lean();

        if (stats.length === 0) {
          await new models.stats(conditions).save();
        } else if (stats.length > 1) {
          let toBeDeleted = stats
            .filter((s) => s.bytes.sent === 0 && s.bytes.received === 0 && s.databaseRows.read === 0 && s.databaseRows.written === 0)
            .map((s) => ({ _id: s._id }));
          if (toBeDeleted.length === stats.length) {
            toBeDeleted = toBeDeleted.slice(1);
          }
          await Promise.all(toBeDeleted.map((d) => models.stats.deleteOne(d)));
        }

        if (jsonData.type === 'bytes.received') {
          let update = {
            $inc: {
              'bytes.received': jsonData.bytes,
            }
          };
          await models.stats.findOneAndUpdate(searchCond, update).exec()
        } else if (jsonData.type === 'bytes.sent') {
          let update = {
            $inc: {
              'bytes.sent': jsonData.bytes,
            }
          };
          await models.stats.findOneAndUpdate(searchCond, update).exec();
        } else if (jsonData.type === 'database.written') {
          let update = {
            $inc: {
              'databaseRows.written': jsonData.rows,
            }
          };
          await models.stats.findOneAndUpdate(searchCond, update).exec();
        } else if (jsonData.type === 'database.read') {
          let update = {
            $inc: {
              'databaseRows.read': jsonData.rows,
            }
          };
          await models.stats.findOneAndUpdate(searchCond, update).exec();
        } else if (jsonData.type === 'job') {
          let update = {
            $push: {
              jobs: {
                name: jsonData.jobName,
                start: jsonData.start,
                duration: jsonData.duration,
              }
            }
          };
          await models.stats.findOneAndUpdate(searchCond, update).exec();
        }
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

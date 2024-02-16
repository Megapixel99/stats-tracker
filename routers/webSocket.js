const models = require('../database/models.js');

let reconnectInterval;
let url;
let failedAttempts = 0;

const WebSocket = require('ws');

const errFunc = (err) => {
  failedAttempts += 1;
  console.error(err);
  if (failedAttempts >= 5) {
    clearInterval(reconnectInterval);
    console.log(`Unable to connect to ${url} after ${failedAttempts} attempts`);
  }
};

function connect(wsUrl, usageLength) {
  url = wsUrl;
  let ws = new WebSocket(url);
  ws.on('open', function() {
    clearInterval(reconnectInterval);
    console.log(`Connected to ${url}`);
    handleConnection(ws, usageLength);
  });
  ws.on('error', errFunc);
}

function handleConnection(ws, usageLength) {
  failedAttempts = 0;
  ws.on('error', errFunc);

  ws.on('message', async (data) => {
    let jsonData = JSON.parse(data);
    let conditions = {
      server: jsonData.name,
      pod: jsonData.pod,
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

  ws.on('close', function() {
    reconnectInterval = setInterval(() => {
      console.log(`Disconnected from ${url}`);
      connect(url, usageLength);
    }, 10000);
  });
};


module.exports = connect;

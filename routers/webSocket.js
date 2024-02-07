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
    const server = (await models.server.findOne({ server: jsonData.name }).lean());
    const stats = (await models.stats.findOne({ server: jsonData.name }).lean());
    let p = []
    if (!server) {
      p.push(new models.server({
        server: jsonData.name,
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
        date: new Date(),
        server: jsonData.name,
        bytes: {
          sent: 0,
          received: 0,
        },
        databaseRows: {
          read: 0,
          written: 0,
        },
        jobs: []
      })
      .save());
    }
    await Promise.all(p);
    switch (jsonData.type) {
      case 'memory':
        models.server.findOneAndUpdate({
         server: jsonData.name,
        }, {
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
        break;
      case 'bytes.received':
        models.stats.findOneAndUpdate({
          server: jsonData.name,
        }, {
          $inc: {
            'bytes.received': jsonData.bytes,
          }
        }).exec();
        break;
      case 'bytes.sent':
        models.stats.findOneAndUpdate({
            server: jsonData.name,
          }, {
            $inc: {
              'bytes.sent': jsonData.bytes,
            }
          }).exec();
        break;
      case 'database.written':
        if (!Number.isNaN(jsonData.rows)) {
          models.stats.findOneAndUpdate({
            server: jsonData.name,
          }, {
            $inc: {
              'databaseRows.written': jsonData.rows,
            }
          }).exec();
        }
        break;
      case 'database.read':
        if (!Number.isNaN(jsonData.rows)) {
          models.stats.findOneAndUpdate({
            server: jsonData.name,
          }, {
            $inc: {
              'databaseRows.read': jsonData.rows,
            }
          }).exec();
        }
        break;
      case 'job':
        let update = {};
        update.$push = {
          jobs: {
            name: jsonData.jobName,
            start: jsonData.start,
            duration: jsonData.duration,
          }
        };
        models.stats.findOneAndUpdate({ server: jsonData.name }, update).exec();
        break;
    }
  });

  ws.on('close', function() {
    reconnectInterval = setInterval(() => {
      console.log(`Disconnected from ${url}`);
      connect(url);
    }, 10000);
  });
};


module.exports = connect;

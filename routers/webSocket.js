const models = require('../database/models.js');

let reconnectInterval;
let url;

const WebSocket = require('ws');

function connect(wsUrl) {
  url = wsUrl;
  let ws = new WebSocket(url);
  ws.on('open', function() {
    clearInterval(reconnectInterval);
    handleConnection(ws);
  });
}

function handleConnection(ws) {
  ws.on('error', console.error);

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
             date: new Date(),
             cpuUsage: jsonData.cpu,
             memoryUsage: jsonData.memory,
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
      connect(url);
    }, 10000);
  });
};


module.exports = connect;

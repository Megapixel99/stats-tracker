const { tracker, dashboard } = require('../index.js');
const { mongoUrl } = require('./env.js');

const { WebSocketServer } = require('ws');

let ws = tracker({
  port: 3001,
  name: 'test',
});

dashboard({
  port: 3000,
  mongoUrl,
  urls: ['ws://localhost:3001']
})

let inter = setInterval(function () {
  if (ws.isConnected()) {
    let j = ws.job.start('job');

    setTimeout(function () {
      j.stop();
    }, 10000);

    ws.bytes.sent({
      'p': 'p',
    });

    ws.bytes.received({
      'p': 'p',
    });

    ws.database.read(20);

    ws.database.written(25);

    clearInterval(inter);
  }
}, 5000);

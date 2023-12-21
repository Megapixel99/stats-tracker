const { tracker, dashboard } = require('../index.js');
const { mongoUrl } = require('./env.js');

let t = tracker({
  port: 3001,
  name: 'test',
});

dashboard({
  port: 3000,
  mongoUrl,
  urls: ['ws://localhost:3001']
})

let inter = setInterval(function () {
  if (t.isConnected()) {
    let j = t.job.start('job');

    setTimeout(function () {
      j.stop();
    }, 10000);

    t.bytes.sent({
      'p': 'p',
    });

    t.bytes.received({
      'p': 'p',
    });

    t.database.read(20);

    t.database.written(25);

    clearInterval(inter);
  }
}, 5000);

const { tracker, dashboard } = require('../index.js');
const { mongoUrl } = require('./env.js');

dashboard({
  port: 3000,
  mongoUrl: mongoUrl,
})

let t = tracker({
  name: 'test',
  pod: 'test-1',
  url: 'localhost:3000'
});

let inter = setInterval(function () {
  if (t.isConnected()) {
    let j = t.job.start('job');

    setTimeout(function () {
      j.stop();
    }, 10000);

    t.data.sent({
      'test': 'data',
    });

    t.data.received({
      'test': 'data',
    });

    t.bytes.sent(10);

    t.bytes.received(15);

    t.databaseRows.read(20);

    t.databaseRows.written(25);

    t.database.read([{
      'test': 'data',
    }]);

    t.database.written([{
      'test': 'data',
    }]);

    clearInterval(inter);
  }
}, 5000);

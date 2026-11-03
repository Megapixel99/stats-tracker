// Runs a dashboard and an app that reports to it in one process.
//   docker run -d -p 27017:27017 mongo:7
//   MONGO_URL=mongodb://127.0.0.1:27017/stats-demo npm run demo
// then open http://localhost:3000 and http://localhost:3001/items/1
const express = require('express');
const { tracker, dashboard } = require('../index.js');
const { mongoUrl } = require('./env.js');

const dash = dashboard({
  port: 3000,
  mongoUrl,
  timezone: 'America/Los_Angeles',
});

const t = tracker({
  name: 'demo-app',
  url: 'http://localhost:3000',
});

// Any Express (4 or 5) or plain http app: one line, and every request is
// counted as a job named after its route.
const app = express();
app.use(t.middleware());
app.get('/items/:id', (req, res) => {
  t.databaseRows.read(1);
  res.json({ id: req.params.id });
});
const server = app.listen(3001);

// And work that is not an HTTP request is timed by hand.
setInterval(() => {
  const job = t.job.start('nightly sync');
  t.data.received({ test: 'data' });
  t.databaseRows.written(25);
  setTimeout(() => job.stop(), Math.random() * 2000);
}, 5000);

process.once('SIGINT', async () => {
  await t.close();
  server.close();
  await dash.close();
  process.exit(0);
});

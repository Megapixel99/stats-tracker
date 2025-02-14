const mongoose = require('mongoose');
const { DateTime } = require('luxon');

const serverSchema = mongoose.Schema({
  server: String,
  pod: String,
  active: { type: Boolean, default: false },
  usage: [{
    date: { type: Date, default: DateTime.now().toJSDate() },
    cpuUsage: { type: Number, default: 0 },
    memoryUsage: { type: Number, default: 0 },
  }],
  uptime: { type: Number, default: 0 },
});

const statSchema = mongoose.Schema({
  date: { type: Date, default: DateTime.now().startOf('day').toJSDate() },
  server: String,
  bytes: {
    sent: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
  },
  databaseRows: {
    read: { type: Number, default: 0 },
    written: { type: Number, default: 0 },
  },
  jobs: [{
    name: String,
    start: { type: Date, default: DateTime.now().toJSDate() },
    duration: { type: Number, default: 0 },
  }]
});

module.exports = {
  server: mongoose.model('Server', serverSchema),
  stats: mongoose.model('Stats', statSchema),
};

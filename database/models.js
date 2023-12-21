const mongoose = require('mongoose');

const serverSchema = mongoose.Schema({
  server: String,
  usage: [{
    date: Date,
    cpuUsage: Number,
    memoryUsage: Number,
  }],
  uptime: Number,
});

const statSchema = mongoose.Schema({
  date: Date,
  server: String,
  bytes: {
    sent: Number,
    received: Number,
  },
  databaseRows: {
    read: Number,
    written: Number,
  },
  jobs: [{
    name: String,
    start: Date,
    duration: Number,
  }]
});

module.exports = {
  server: mongoose.model('Server', serverSchema),
  stats: mongoose.model('Stats', statSchema),
};

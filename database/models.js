const mongoose = require('mongoose');

// One document per running process.
const serverSchema = new mongoose.Schema({
  server: { type: String, required: true },
  pod: { type: String, required: true },
  active: { type: Boolean, default: false },
  lastSeen: { type: Date, default: Date.now },
  // Id of the last batch applied, to recognise one that is resent.
  lastBatch: { type: String },
  usage: [{
    _id: false,
    date: { type: Date, default: Date.now },
    cpuUsage: { type: Number, default: 0 },
    memoryUsage: { type: Number, default: 0 },
  }],
  uptime: { type: Number, default: 0 },
});
serverSchema.index({ server: 1, pod: 1 }, { unique: true });
serverSchema.index({ active: 1, lastSeen: 1 });

// One document per application per day. Every write is an `$inc`, so replicas
// reporting at the same moment add up instead of overwriting each other.
const statSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  server: { type: String, required: true },
  bytes: {
    sent: { type: Number, default: 0 },
    received: { type: Number, default: 0 },
  },
  databaseRows: {
    read: { type: Number, default: 0 },
    written: { type: Number, default: 0 },
  },
  jobCount: { type: Number, default: 0 },
});
statSchema.index({ server: 1, date: 1 }, { unique: true });
statSchema.index({ date: 1 });

// One document per application, day and job name, instead of an array of
// every run: the array had to be capped, which made the counts wrong.
const jobSchema = new mongoose.Schema({
  date: { type: Date, required: true },
  server: { type: String, required: true },
  name: { type: String, required: true },
  count: { type: Number, default: 0 },
  totalDuration: { type: Number, default: 0 },
  lastStart: { type: Date },
  lastDuration: { type: Number, default: 0 },
});
jobSchema.index({ server: 1, date: 1, name: 1 }, { unique: true });

const createModels = (connection) => ({
  server: connection.model('Server', serverSchema),
  stats: connection.model('Stats', statSchema),
  jobs: connection.model('JobStats', jobSchema),
});

module.exports = createModels;

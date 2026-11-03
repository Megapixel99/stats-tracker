// Loaded lazily so an app that only reports stats never loads express,
// mongoose or ejs (which are optional peer dependencies for that reason).
module.exports = {
  get tracker() {
    return require('./lib/tracker.js');
  },
  get dashboard() {
    return require('./lib/dashboard.js');
  },
};

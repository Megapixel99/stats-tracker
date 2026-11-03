const dashboard = require('./lib/dashboard.js');
require('dotenv').config({ quiet: true });

dashboard({
  port: Number(process.env.PORT) || 3000,
  mongoUrl: process.env.MONGO_URL,
  token: process.env.INGEST_TOKEN,
  timezone: process.env.TZ || 'UTC',
  usageLength: Number(process.env.USAGE_LENGTH) || 100,
});

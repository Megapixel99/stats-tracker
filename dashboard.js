const { dashboard } = require('./index.js');
require('dotenv').config()

dashboard({
  port: process.env.PORT,
  mongoUrl: process.env.MONGO_URL,
  urls: process.env.URLS.split(',').filter((e) => e),
  usageLength: process.env.USAGE_LENGTH,
});

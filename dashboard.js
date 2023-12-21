const { dashboard } = require('./index.js');
require('dotenv').config()

dashboard({
  port: process.env.PORT,
  mongoUrl: process.ENV.MONGO_URL,
  urls: process.ENV.URLS.split(','),
});

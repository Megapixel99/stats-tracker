const path = require('path');
require('dotenv').config({
  path: path.resolve(`${__dirname}/../.env`),
});

const env = {
  mongoUrl: process.env.MONGO_URL,
  env: (process.env.ENV ?? ''),
};

module.exports = env;

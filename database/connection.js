const mongoose = require('mongoose');

// A connection of its own rather than mongoose's global one, so the dashboard
// can live inside an app that also uses mongoose without either clobbering
// the other's models or connection.
function connect(mongoUrl, logger = console, {
  retryDelay = 5000,
  serverSelectionTimeoutMS = 10000,
} = {}) {
  const connection = mongoose.createConnection();
  let closing = false;

  connection.on('connected', () => logger.log('tallyboard: connected to MongoDB'));
  connection.on('disconnected', () => {
    if (!closing) {
      logger.error('tallyboard: disconnected from MongoDB');
    }
  });
  // Without a listener an 'error' event would crash the process; the driver
  // reconnects on its own once a connection has been made, so logging is
  // all that is needed here.
  connection.on('error', (err) => logger.error(`tallyboard: MongoDB error: ${err.message}`));

  // The driver does not retry a first connection that fails, which would
  // leave a pod started while MongoDB was down unready forever.
  const open = () => connection
    .openUri(mongoUrl, { serverSelectionTimeoutMS })
    .catch((err) => {
      if (closing) {
        throw err;
      }
      logger.error(`tallyboard: could not connect to MongoDB, retrying in ${retryDelay / 1000}s: ${err.message}`);
      return new Promise((resolve) => { setTimeout(resolve, retryDelay); }).then(open);
    });

  return {
    connection,
    opened: open(),
    close: () => {
      closing = true;
      return connection.close();
    },
  };
}

const isConnected = (connection) => connection.readyState === mongoose.ConnectionStates.connected;

module.exports = {
  connect,
  isConnected,
};

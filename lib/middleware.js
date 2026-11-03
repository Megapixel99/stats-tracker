// Works on the plain Node request/response pair, so the same middleware
// serves Express 4, Express 5, Connect, or a bare `http.createServer` handler.

const chunkLength = (chunk, encoding) => {
  if (chunk === undefined || chunk === null || typeof chunk === 'function') {
    return 0;
  }
  if (typeof chunk === 'string') {
    return Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8');
  }
  return chunk.byteLength ?? 0;
};

// Name a request after the route that handled it rather than its URL, so
// `/users/123` and `/users/456` count as one job and an attacker cannot mint
// unlimited job names by requesting random paths.
const defaultName = (req, res) => {
  const route = req.route?.path;
  if (route !== undefined && route !== null) {
    const path = Array.isArray(route) ? route.join('|') : String(route);
    return `${req.method} ${req.baseUrl || ''}${path}`;
  }
  if (res.statusCode === 404) {
    return `${req.method} (unmatched)`;
  }
  return `${req.method} ${(req.originalUrl || req.url || '').split('?')[0]}`;
};

function createMiddleware(tracker, options = {}) {
  const skip = options.skip || (() => false);
  const nameOf = options.name || defaultName;

  return function tallyboard(req, res, next) {
    if (skip(req)) {
      next();
      return;
    }

    const start = Date.now();
    let sent = 0;
    const { write, end } = res;

    res.write = function trackedWrite(chunk, encoding, cb) {
      sent += chunkLength(chunk, encoding);
      return write.call(this, chunk, encoding, cb);
    };
    res.end = function trackedEnd(chunk, encoding, cb) {
      sent += chunkLength(chunk, encoding);
      return end.call(this, chunk, encoding, cb);
    };

    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      // Counting request bodies by listening for 'data' would switch the
      // stream to flowing mode before a body parser is attached, so the
      // declared length is used instead. Chunked uploads count as zero.
      tracker.bytes.received(Number(req.headers['content-length']) || 0);
      tracker.bytes.sent(sent);
      tracker.job.start(nameOf(req, res), start).stop();
    };
    res.once('finish', finish);
    // 'close' without 'finish' is a client that hung up mid-response.
    res.once('close', finish);

    next();
  };
}

module.exports = createMiddleware;
module.exports.defaultName = defaultName;

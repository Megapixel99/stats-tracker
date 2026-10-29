const http = require('node:http');

// A stand-in dashboard that records every batch it is sent. `delay` holds
// the response back (to make the tracker time out) after the batch has
// already been recorded, which is what a slow real dashboard looks like.
async function fakeDashboard({ status = 204, delay = 0 } = {}) {
  const batches = [];
  const requests = [];
  const state = { status, delay };
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      requests.push({ url: req.url, headers: req.headers, body: parsed });
      if (state.status < 300) {
        batches.push(parsed);
      }
      setTimeout(() => {
        res.statusCode = state.status;
        res.end();
      }, state.delay);
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    batches,
    requests,
    setStatus: (s) => { state.status = s; },
    setDelay: (d) => { state.delay = d; },
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(resolve);
    }),
  };
}

const quietLogger = () => {
  const lines = [];
  return {
    lines,
    log: (...m) => lines.push(['log', m.join(' ')]),
    error: (...m) => lines.push(['error', m.join(' ')]),
  };
};

module.exports = {
  fakeDashboard,
  quietLogger,
};

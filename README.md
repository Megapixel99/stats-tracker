# tallyboard

This module exposes two functions: `tracker` and `dashboard`.

The `tracker` function relays information about the current Node.js process to
the dashboard (wherever the `dashboard` function is running): CPU and memory,
bytes sent and received, database rows read and written, and how long jobs take.

The tracker has no dependencies. It collects stats in memory and POSTs them to
the dashboard in one batch every 10 seconds, so a busy app makes the same six
requests a minute as an idle one. Its timers never keep a process alive, so a
cron job that uses it still exits on its own, and reports one last time as it
does.

## tracker

```javascript
const { tracker } = require('tallyboard');
// or, to be explicit that nothing else is loaded:
// const tracker = require('tallyboard/tracker');

const t = tracker({
  name: 'test', // required: the application, shared by all of its replicas
  url: 'http://my-dashboard:3000', // where the dashboard runs; without it the tracker does nothing
  pod: 'test-1', // tells replicas apart; defaults to os.hostname(), which is the pod name in Kubernetes
  token: 'secret', // sent as a bearer token, if the dashboard was given one
  flushInterval: 10000, // how often to report, in milliseconds
  logger: console, // defaults to console; anything with `log` and `error` works
});
```

Leaving out `url` makes every call a no-op, which is handy for tests and local
development: there is no need to wrap the tracker in `if` statements.

### Recording stats

| Function | Argument |
| --- | --- |
| `bytes.sent(n)` / `bytes.received(n)` | a number of bytes |
| `data.sent(data)` / `data.received(data)` | raw data; strings and buffers count their byte length, anything else its JSON length |
| `database.read(data)` / `database.written(data)` | an array of rows (its length is counted), or a single row |
| `databaseRows.read(n)` / `databaseRows.written(n)` | a number of rows |
| `job.start(jobName [, start])` | starts a job and returns `{ stop() }`; `start` defaults to `Date.now()` |

Anything that is not a non-negative finite number is ignored, so a stray
`undefined` or `'abc'` cannot corrupt the totals.

```javascript
const job = t.job.start('nightly sync');

// some other code which takes a while to run goes here

job.stop(); // returns the duration in milliseconds; calling it again does nothing
```

### HTTP middleware

```javascript
app.use(t.middleware());
```

The middleware works on the plain Node request and response, so it is the same
for Express 4, Express 5, Connect or a bare `http.createServer` handler. For
every request it counts the response bytes actually written, the request's
`Content-Length`, and records a job named after the route that handled it
(`GET /users/:id`, not `GET /users/123`), so the job list stays the size of the
app's routes. Requests that matched no route are grouped as
`GET (unmatched)`.

```javascript
app.use(t.middleware({
  skip: (req) => req.path.startsWith('/_health'), // not counted at all
  name: (req, res) => `${req.method} ${req.path}`, // replace the default job name
}));
```

### Lifecycle

| Function | |
| --- | --- |
| `flush()` | report now; resolves to whether the dashboard accepted it |
| `close()` | stop reporting and send a final batch, which removes this pod from the dashboard's list right away |
| `isConnected()` | whether the last report reached the dashboard |

If the dashboard is down, counts are kept and sent with the next report that
gets through. An outage is logged once, not on every retry. A report that
timed out may still have been applied, so it is resent unchanged under the
same id, and the dashboard skips an id it has already counted: nothing is
counted twice.

The final report is sent automatically when the event loop runs dry, which is
how a cron job ends. Node does not allow that for `process.exit()` or a signal,
so in those paths call `await t.close()` first:

```javascript
process.once('SIGTERM', async () => {
  await t.close();
  process.exit(0);
});
```

## dashboard

The `dashboard` function serves a web dashboard (built with Express 5 and EJS)
showing what the trackers report, and the endpoint they report to. It stores
everything in MongoDB.

Its dependencies are not dependencies of this package, so installing it for
the tracker alone pulls in nothing, and an app on Express 4 can use the
tracker without a version conflict. Wherever the dashboard runs, install them
alongside it (it checks for them, and for Express 5 or newer, when loaded):

```
npm install tallyboard express@5 ejs express-ejs-layouts luxon mongoose
```

```javascript
const { dashboard } = require('tallyboard');

const dash = dashboard({
  port: 3000,
  mongoUrl: 'mongodb://yourUrl',
  token: 'secret', // if set, trackers must send it
  timezone: 'America/Los_Angeles', // where "today" starts; defaults to 'UTC'
  usageLength: 100, // CPU and memory samples kept per pod for the averages
  inactiveAfter: 60000, // a pod that has not reported for this long is shown as gone
  logger: console, // defaults to console if nothing is passed
});

// dash.app is the Express app, to add routes of your own
dash.app.get('/healthz', (req, res) => res.sendStatus(dash.isReady() ? 200 : 503));

// dash.close() stops the server and disconnects from MongoDB
```

Applications are listed while they have a running pod, and for 7 days after
they last reported (`recentDays`), so a cron job does not disappear between
runs.

The overview shows four figures for today, the past week, month or year
(requests and jobs, data transferred, rows read, rows written), each with a
12-bucket trend, and each app's share of them. An app's page adds its pods
and its jobs: runs and average time in the period, and how long the last run
took. Pages refresh themselves every 10 seconds; `?period=week` (or `day`,
`month`, `year`) picks the period, and links keep it. The same data is
available as JSON at `/stats` and `/server/:name/jobs`.

The pages are plain HTML and one stylesheet, with no web fonts or CDN, so
they work in a cluster with no internet access. They follow the system's
light or dark mode.

If you want to spin up the dashboard as a standalone application you can run
`npm run dashboard` with `MONGO_URL` (and optionally `PORT`, `INGEST_TOKEN`,
`TZ`, `USAGE_LENGTH`) set, or build the `Dockerfile`.

### For a full (running/working) demo, see `demo/demo.js` (you will need a running MongoDB for the demo)

## Upgrading from 1.x

- The package is published to npm as `tallyboard`. 1.x was installed from
  GitHub as `stats-tracker`, a name already taken on npm, so update the
  dependency and every `require('stats-tracker')`.
- Trackers now report over HTTP instead of a WebSocket. A 2.x tracker needs a
  2.x dashboard; `url` values written for 1.x (`host:port`, `ws://host:port`)
  are still accepted.
- `pod` defaults to the hostname instead of `name`.
- The dashboard runs on Express 5, and `dashboard()` returns `app`, `server`
  and `close()` alongside the old `expressServer` and `appSetInactive`.
- Jobs are stored as one document per application, day and job name, in a new
  `jobstats` collection, and the day totals carry a `jobCount`. The `jobs`
  array on the old day documents is no longer read.
- `data.sent()`/`data.received()` count JSON or byte length rather than the
  size of V8's serialisation.

## Testing

```
npm test
```

The dashboard's end-to-end tests run against a real MongoDB and are skipped
unless `MONGO_URL` is set:

```
docker run -d -p 27017:27017 mongo:7
MONGO_URL=mongodb://127.0.0.1:27017 npm test
```

## Releasing

Bump `version` in `package.json` (`npm version minor --no-git-tag-version`)
and merge it to `master`. The Release workflow then runs the tests against
MongoDB, tags `vX.Y.Z`, creates the GitHub release, and publishes to npm
(trusted publishing, no token) and to GitHub Packages as
`@megapixel99/tallyboard`. A version that is already tagged and published is
left alone, and a run that failed halfway can be finished from the Actions
tab with "Run workflow".

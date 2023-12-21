# Stats Tracker

This module exposes two functions: `dashboard` and `tracker`

The `tracker` function can be used to relay information about the current NodeJS
process to the dashboard (wherever the `dashboard` function is running).

## tracker(config [, logger])

The tracker takes two arguments, `config` and an optional `logger` (defaults to console). The tracker connects to the dashboard via web sockets and exposes a web socket server which the dashboard can connect to.

The `config` can be used to pass the port of the web socket server and the name of the application.
```javascript
const { tracker } = require('stats-tracker');

let t = tracker({
  port: 3001,
  name: 'test',
});
```

The functions that `tracker` exposes are:

`bytes.sent(data)`:

The `data` argument the function takes is assumed to be `utf8` and will be converted into a String, then a Buffer so the number of bytes can be sent to the dashboard.

`bytes.received(data)`:

The `data` argument the function takes is assumed to be `utf8` and will be converted into a String, then a Buffer so the number of bytes can be sent to the dashboard.

`database.read(data)`:

The `data` argument the function takes is assumed to be a JSON array and the length of the JSON array will be sent to the dashboard.

`database.written(data)`:

The `data` argument the function takes is assumed to be a JSON array and the length of the JSON array will be sent to the dashboard.

`job.start(jobName [, start])`:

This function will start a job, and returns a job so you can stop it later, it is up to you to end the job manually with `job.stop()`.
The `jobName` argument is the name of the job that you will see in the dashboard.
The optional `start` argument is the time when the job started in milliseconds (defaults to `Date.now()`)

`job.stop()`:

This function will stop a job and data about the job will be sent to the dashboard.

#### How to use job.start() and job.stop()

```javascript

const { tracker } = require('stats-tracker');

let t = tracker({
  port: 3001,
  name: 'test',
});

let job1 = t.job.start('jobName');

// some other code which takes a while to run goes here

job1.stop();
```

## dashboard

The `dashboard` function exposes a web-based dashboard (built using `express` and `ejs`) to see information about the various trackers that are feeding information to it (via web sockets).

The `dashboard` function take two arguments, a `config` argument and an optional `logger` (defaults to console).

The `config` and be used to pass the port you want the dashboard to run on, the URL of the Mongo Database you will be using, and the url(s) or the various applications running the `tracker` function.

```javascript
const { dashboard } = require('stats-tracker');

dashboard({
  port: 3000,
  mongoUrl: 'mongodb://yourUrl',
  urls: ['ws://firstTracker', 'ws://secondTracker']
});
```

### For a full (running/working) demo, please see `demo.js` in the demo folder

# Stats Tracker

This module exposes two functions: `dashboard` and `tracker`

The `tracker` function can be used to relay information about the current NodeJS
process to the dashboard (wherever the `dashboard` function is running).

## tracker

The tracker takes one argument, `config`.

The `config` can be used to pass the URL of the dashboard (which exposes a web socket server) and the name of the application among other things.

```javascript
const { tracker } = require('stats-tracker');

let t = tracker({
  name: 'test',
  pod: 'test-1', // useful if running multiple instances of the same application, defaults to the name, in this case `test`
  logger: console, // defaults to console if nothing is passed
  url: 'http://myDashboard', // HTTP route to to dashboard
});
```

The functions that `tracker` exposes are:

`bytes.sent(data)`:

The `data` argument the function takes needs to be a number and is assumed to be the number of bytes sent.

`bytes.received(data)`:

The `data` argument the function takes needs to be a number and is assumed to be the number of bytes received.

`data.sent(data)`:

The `data` argument the function takes is assumed to be raw data and thus will be serialized and converted to bytes.

`data.received(data)`:

The `data` argument the function takes is assumed to be raw data and thus will be serialized and converted to bytes.

`database.read(data)`:

The `data` argument the function takes is assumed to be a JSON array and the length of the JSON array will be sent to the dashboard.

`database.written(data)`:

The `data` argument the function takes is assumed to be a JSON array and the length of the JSON array will be sent to the dashboard.

`databaseRows.sent(data)`:

The `data` argument the function takes needs to be a number and is assumed to be the number of rows sent.

`databaseRows.received(data)`:

The `data` argument the function takes needs to be a number and is assumed to be the number of rows received.

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
  name: 'test',
  pod: 'test-1',
  logger: console, // defaults to console if nothing is passed
});

let job1 = t.job.start('jobName');

// some other code which takes a while to run goes here

job1.stop();
```

## dashboard

The `dashboard` function exposes a web-based dashboard (built using `express` and `ejs`) to see information about the various trackers that are feeding information to it (via web sockets).

The `dashboard` function takes one argument, `config`.

The `config` can be used to pass the port you want the dashboard to run on, the URL of the Mongo Database you will be using along with `usageLength` and a `logger`.

```javascript
const { dashboard } = require('stats-tracker');

dashboard({
  port: 3000,
  mongoUrl: 'mongodb://yourUrl',
  usageLength: 100, // determines how much CPU usage info to save in the database (for the average CPU usage to be determined), defaults to 100 and is updated every 5 seconds
  logger: console, // defaults to console if nothing is passed
  timezone: 'UTC', // defaults to 'UTC' if nothing is passed, supports the timezones in `Intl`
});
```

If you want to spin up the dashboard as a standalone application you can run: `npm run dashboard`

### For a full (running/working) demo, please see `demo.js` in the demo folder (you will need a running mongo database for the demo)

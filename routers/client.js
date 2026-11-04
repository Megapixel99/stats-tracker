const express = require('express');
const { serverStats, serverJobs, periodOf } = require('../functions/index.js');

// `?period=week` picks what the figures cover. `?fragment=1` returns only the
// page's content, rendered from the same template, which the page fetches to
// refresh itself in place.
const render = (req, res, page, content, data) => {
  const locals = { ...data, period: periodOf(req.query.period) };
  if (req.query.fragment !== undefined) {
    res.render(`partials/${content}`, { ...locals, layout: false });
  } else {
    res.render(`pages/${page}`, locals);
  }
};

// Express 5 forwards a rejected promise to the error handler on its own, so
// these handlers no longer need `.catch(next)`.
function clientRouter(models, config) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    render(req, res, 'dashboard', 'overview', {
      title: 'Tallyboard',
      ...await serverStats(models, config),
    });
  });

  router.get('/stats', async (req, res) => {
    res.json(await serverStats(models, config));
  });

  router.get('/server/:serverName', async (req, res) => {
    const jobs = await serverJobs(models, req.params.serverName, config);
    if (!jobs) {
      res.redirect('/');
      return;
    }
    render(req, res, 'serverInfo', 'app', { title: `${jobs.name} · Tallyboard`, ...jobs });
  });

  router.get('/server/:serverName/jobs', async (req, res) => {
    const jobs = await serverJobs(models, req.params.serverName, config);
    if (!jobs) {
      res.sendStatus(404);
      return;
    }
    res.json(jobs);
  });

  return router;
}

module.exports = clientRouter;

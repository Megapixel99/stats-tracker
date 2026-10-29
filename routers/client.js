const express = require('express');
const { serverStats, serverJobs } = require('../functions/index.js');

// Express 5 forwards a rejected promise to the error handler on its own, so
// these handlers no longer need `.catch(next)`.
function clientRouter(models, config) {
  const router = express.Router();

  router.get('/', async (req, res) => {
    res.render('pages/dashboard', await serverStats(models, config));
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
    res.render('pages/serverInfo', jobs);
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

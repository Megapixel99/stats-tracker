const router = require('express').Router();
const path = require('path');
const { serverStats, serverJobs } = require('../functions/index.js');

router.get('/', async (req, res, next) => {
   serverStats()
   .then((serverStats) => res.render(`pages/dashboard`, serverStats))
   .catch(next);
});

router.get('/stats', async (req, res, next) => {
  serverStats()
  .then((serverStats) => res.json(serverStats))
  .catch(next);
});

router.get('/server/:serverName', async (req, res, next) => {
  serverJobs(req.params.serverName)
  .then((serverJobs) => {
    if (!serverJobs) {
      return res.redirect('/')
    }
    res.render(`pages/serverInfo`, serverJobs);
  })
  .catch(next);
});

router.get('/server/:serverName/jobs', async (req, res, next) => {
  serverJobs(req.params.serverName)
  .then((serverJobs) => {
    if (!serverJobs) {
      return res.sendStatus(404);
    }
    res.json(serverJobs);
  })
  .catch(next);
});

module.exports = router;

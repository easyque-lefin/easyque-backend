const express = require('express');
const router = express.Router();
const { onClientSubscribe } = require('../services/liveBus');

// Server-Sent Events endpoint
router.get('/', (req, res) => {
  // Clients pass ?org_id=...&assigned_user_id=... (optional)
  onClientSubscribe(req, res);
});

module.exports = router;



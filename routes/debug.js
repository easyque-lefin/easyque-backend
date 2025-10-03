// routes/debug.js
const express = require('express');
const db = require("../services/db"); // assumes db.query(sql, params)
const router = express.Router();

router.get('/db', async (req, res) => {
  try {
    // report DB connection info and a small env snapshot
    const rows = await db.query('SELECT DATABASE() AS db_name, USER() AS db_user');
    res.json({
      ok: true,
      db: rows && rows[0] ? rows[0] : null,
      env: {
        DB_HOST: process.env.DB_HOST || null,
        DB_USER: process.env.DB_USER || null,
        DB_NAME: process.env.DB_NAME || null,
        NODE_CWD: process.cwd(),
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;

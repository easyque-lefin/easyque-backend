const express = require('express');
const path = require('path');
const db = require('../db');
const { orgSnapshot } = require('../services/liveBus');
const { ASSIGNED } = require('../services/metrics');

const router = express.Router();

// serve the HTML shell
router.get('/:queue_code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'status.html'));
});

// bootstrap JSON for shell
router.get('/api/:queue_code', async (req, res, next) => {
  try {
    const { queue_code } = req.params;
    const [bks] = await db.query(
      `SELECT id, org_id, token_no, booking_date, user_name, user_phone, assigned_user_id
         FROM bookings WHERE queue_code = ? LIMIT 1`,
      [queue_code]
    );
    if (!bks.length) return res.status(404).json({ ok:false, error:'not_found' });

    const bk = bks[0];

    const [orgs] = await db.query(
      `SELECT id, name, banner_url FROM organizations WHERE id = ? LIMIT 1`,
      [bk.org_id]
    );
    const org = orgs.length ? orgs[0] : null;

    const snap = await orgSnapshot(bk.org_id, ASSIGNED ? bk.assigned_user_id : null, bk.token_no);

    res.json({
      ok: true,
      org: org ? { id: org.id, name: org.name, banner_url: org.banner_url || null } : null,
      booking: {
        id: bk.id,
        token_no: bk.token_no,
        booking_date: bk.booking_date,
        user_name: bk.user_name,
        user_phone: bk.user_phone,
        assigned_user_id: bk.assigned_user_id || null
      },
      now: snap || null,
      // point SSE to org + (optional) assigned user
      stream_url: ASSIGNED
        ? `/live/stream/${bk.org_id}/${bk.assigned_user_id || 0}`
        : `/live/stream/${bk.org_id}`
    });
  } catch (e) { next(e); }
});

module.exports = router;

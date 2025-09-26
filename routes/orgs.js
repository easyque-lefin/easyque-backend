const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const db = require('../db');
const { startBreak, endBreak } = require('../services/metrics');
const { sendLive } = require('../services/liveBus');

const router = express.Router();

const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const orgId = req.params.id;
    const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
    cb(null, `org_${orgId}_banner${ext}`);
  }
});
const upload = multer({ storage });

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [rows] = await db.query(
      `SELECT id, name, banner_url, now_serving_token, service_start_at, avg_service_seconds, break_started_at, break_until
         FROM organizations WHERE id = ?`, [id]
    );
    if (!rows.length) return res.status(404).json({ ok:false, error:'not_found' });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

router.post('/:id/banner', upload.single('banner'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!req.file) return res.status(400).json({ ok:false, error:'file_required' });

    // public path (served by app.use('/uploads', express.static(...)))
    const rel = `/uploads/${req.file.filename}`;

    // if you want absolute URL, prepend LIVE_BASE_URL
    const base = process.env.LIVE_BASE_URL || '';
    const full = base && base.startsWith('http') ? `${base.replace(/\/+$/, '')}${rel}` : rel;

    await db.query(`UPDATE organizations SET banner_url = ? WHERE id = ?`, [full, id]);

    res.json({ ok:true, banner_url: full });
  } catch (e) { next(e); }
});

// Break toggle
router.post('/:id/break', async (req, res, next) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    const { assigned_user_id = null, until = null } = req.body || {};
    await startBreak(orgId, assigned_user_id || null, until ? new Date(until) : null, null);
    await sendLive(orgId, assigned_user_id || null);
    res.json({ ok:true });
  } catch (e) { next(e); }
});

router.delete('/:id/break', async (req, res, next) => {
  try {
    const orgId = parseInt(req.params.id, 10);
    const { assigned_user_id = null } = req.query || {};
    await endBreak(orgId, assigned_user_id ? parseInt(assigned_user_id,10) : null);
    await sendLive(orgId, assigned_user_id ? parseInt(assigned_user_id,10) : null);
    res.json({ ok:true });
  } catch (e) { next(e); }
});

module.exports = router;


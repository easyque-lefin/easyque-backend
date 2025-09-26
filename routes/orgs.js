const express = require('express');
const router = express.Router();
const db = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { sendLive } = require('../services/liveBus');

// ------- banner upload (kept as you had) -------
const uploadDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.png');
    cb(null, `org_${req.params.id}_banner${ext}`);
  }
});
const upload = multer({ storage });

router.post('/:id/banner', upload.single('banner'), async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || !req.file) return res.status(400).json({ ok: false, error: 'missing_file_or_id' });

    const relPath = `/uploads/${path.basename(req.file.path)}`;
    await db.query(`UPDATE organizations SET banner_url = ? WHERE id = ?`, [relPath, id]);
    res.json({ ok: true, banner_url: relPath });
    sendLive(id, null);
  } catch (err) { next(err); }
});

// ------- break toggle APIs -------
router.post('/:id/break/start', async (req, res, next) => {
  try {
    const org_id = parseInt(req.params.id, 10);
    const user_id = parseInt(req.body.user_id, 10);
    const until = req.body.until ? new Date(req.body.until) : null;
    const reason = (req.body.reason || '').trim();

    if (!org_id || !user_id) return res.status(400).json({ ok: false, error: 'missing_params' });

    const now = new Date();
    await db.query(
      `UPDATE organizations
          SET breaking_user_id = ?, break_started_at = ?, break_until = ?
        WHERE id = ?`,
      [user_id, now, until, org_id]
    );
    await db.query(
      `INSERT INTO org_breaks (org_id, user_id, started_at, reason) VALUES (?, ?, ?, ?)`,
      [org_id, user_id, now, reason || null]
    );

    res.json({ ok: true, started_at: now, break_until: until || null });
    sendLive(org_id, user_id);
  } catch (err) { next(err); }
});

router.post('/:id/break/end', async (req, res, next) => {
  try {
    const org_id = parseInt(req.params.id, 10);
    const user_id = parseInt(req.body.user_id, 10);
    if (!org_id || !user_id) return res.status(400).json({ ok: false, error: 'missing_params' });

    const now = new Date();
    await db.query(
      `UPDATE organizations
          SET breaking_user_id = NULL, break_started_at = NULL, break_until = NULL
        WHERE id = ? AND breaking_user_id = ?`,
      [org_id, user_id]
    );
    await db.query(
      `UPDATE org_breaks SET ended_at = ? WHERE org_id = ? AND user_id = ? AND ended_at IS NULL`,
      [now, org_id, user_id]
    );

    res.json({ ok: true, ended_at: now });
    sendLive(org_id, user_id);
  } catch (err) { next(err); }
});

module.exports = router;


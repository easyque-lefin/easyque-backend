const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db'); // uses mysql2/promise pool
const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:5008';
const LIVE_BASE_URL = process.env.LIVE_BASE_URL || `${APP_URL}/public/status.html`;

/* --------------------------- helpers --------------------------- */

async function getTableColumns(table) {
  const [rows] = await db.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return new Set(rows.map(r => r.COLUMN_NAME));
}

function pickColumn(cols, preferred, fallback) {
  if (cols.has(preferred)) return preferred;
  if (fallback && cols.has(fallback)) return fallback;
  return null;
}

function safeNumber(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

function buildStatusLink(org_id, booking_id) {
  // LIVE_BASE_URL can be https://status.easyque.org or a local file url
  const base = LIVE_BASE_URL.includes('http') ? LIVE_BASE_URL : `${APP_URL}/public/status.html`;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}org_id=${encodeURIComponent(org_id)}&booking_id=${encodeURIComponent(booking_id)}`;
}

function buildMessagingLinks(phone, statusLink) {
  // normalize to digits only, allow country code without '+'
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const msg = `Hi! Your EasyQue live status link: ${statusLink}`;
  const enc = encodeURIComponent(msg);
  return {
    whatsapp: digits ? `https://wa.me/${digits}?text=${enc}` : null,
    sms: digits ? `sms:${digits}?&body=${enc}` : null,
  };
}

/* --------------------- token generation (TX) -------------------- */

async function nextTokenForDay(conn, tableCols, org_id, assigned_user_id, booking_date) {
  const tokenCol = pickColumn(tableCols, 'token_number', 'token_no');
  if (!tokenCol) throw new Error('Token column not found (token_number or token_no)');

  // Lock the scope rowset to avoid races
  const [rows] = await conn.query(
    `SELECT COALESCE(MAX(${tokenCol}),0) AS max_tok
     FROM bookings
     WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?
     FOR UPDATE`,
    [org_id, assigned_user_id, booking_date]
  );
  return safeNumber(rows[0]?.max_tok, 0) + 1;
}

/* ---------------------------- create ---------------------------- */
/**
 * Body:
 *  {
 *    org_id, user_name, user_phone, user_alt_phone?, user_email?, place?,
 *    department?, assigned_user_id,
 *    when? (ISO datetime string or null), query_issue?
 *  }
 */
router.post('/', async (req, res, next) => {
  const body = req.body || {};
  const org_id = safeNumber(body.org_id);
  const assigned_user_id = safeNumber(body.assigned_user_id, 0);

  if (!org_id || !body.user_name || !body.user_phone) {
    return res.status(400).json({ ok: false, error: 'org_id, user_name and user_phone are required' });
  }

  const booking_date = dayjs().format('YYYY-MM-DD');
  const scheduled_at = body.when ? dayjs(body.when).isValid() ? dayjs(body.when).format('YYYY-MM-DD HH:mm:ss') : null : null;

  const conn = await db.getConnection();
  try {
    const cols = await getTableColumns('bookings');
    const tokenCol = pickColumn(cols, 'token_number', 'token_no');
    const schedCol = pickColumn(cols, 'scheduled_at', 'booking_datetime');
    const statusCol = cols.has('status') ? 'status' : null;
    const queryIssueCol = cols.has('query_issue') ? 'query_issue' : null;
    const createdAtCol = cols.has('created_at') ? 'created_at' : null;

    if (!cols.has('booking_date')) {
      throw new Error('bookings.booking_date column is required. Please run the migration to add it.');
    }
    if (!tokenCol) {
      throw new Error('bookings token column is required (token_number or token_no). Please run the migration.');
    }

    await conn.beginTransaction();

    const token_number = await nextTokenForDay(conn, cols, org_id, assigned_user_id, booking_date);

    // Build column list dynamically based on what exists
    const names = [
      'org_id',
      'user_name',
      'user_phone',
      cols.has('user_alt_phone') ? 'user_alt_phone' : null,
      cols.has('user_email') ? 'user_email' : null,
      cols.has('place') ? 'place' : null,
      cols.has('department') ? 'department' : null,
      'assigned_user_id',
      'booking_date',
      schedCol,
      tokenCol,
      statusCol,
      queryIssueCol,
      createdAtCol
    ].filter(Boolean);

    const values = [
      org_id,
      body.user_name,
      body.user_phone,
      cols.has('user_alt_phone') ? (body.user_alt_phone || null) : undefined,
      cols.has('user_email') ? (body.user_email || null) : undefined,
      cols.has('place') ? (body.place || null) : undefined,
      cols.has('department') ? (body.department || null) : undefined,
      assigned_user_id,
      booking_date,
      schedCol ? (scheduled_at || null) : undefined,
      token_number,
      statusCol ? 'pending' : undefined,
      queryIssueCol ? (body.query_issue || null) : undefined,
      createdAtCol ? null : undefined, // will use NOW() if we put it in SQL
    ].filter(v => v !== undefined);

    // Prepare placeholders
    const qMarks = names.map(() => '?').join(', ');

    // If created_at exists, use NOW() directly instead of binding (to avoid timezone differences)
    const namesSql = names.map(n => (n === createdAtCol ? n : n)).join(', ');
    const sql = `INSERT INTO bookings (${namesSql}) VALUES (${qMarks})`;

    // For created_at bound value, we passed null above; adjust to NOW() by editing sql if needed.
    let finalSql = sql;
    let finalValues = [...values];
    if (createdAtCol) {
      // Replace the last ? (which corresponds to created_at) with NOW()
      const idx = names.lastIndexOf(createdAtCol);
      // rebuild with NOW()
      const parts = qMarks.split(', ');
      parts[idx] = 'NOW()';
      finalSql = `INSERT INTO bookings (${namesSql}) VALUES (${parts.join(', ')})`;
      // remove the placeholder value for created_at (we added null)
      finalValues = values.filter((_, i) => i !== idx);
    }

    const [result] = await conn.query(finalSql, finalValues);
    const booking_id = result.insertId;

    await conn.commit();

    const statusLink = buildStatusLink(org_id, booking_id);
    const messaging = buildMessagingLinks(body.user_phone, statusLink);

    res.json({
      ok: true,
      statusLink,
      messaging,
      booking: {
        id: booking_id,
        org_id,
        user_name: body.user_name,
        user_phone: body.user_phone,
        assigned_user_id,
        booking_date,
        [tokenCol]: token_number
      }
    });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
});

/* ----------------------------- list ----------------------------- */
// GET /bookings?org_id=1&date=YYYY-MM-DD&assigned_user_id=5&department=Cardio
router.get('/', async (req, res, next) => {
  try {
    const org_id = safeNumber(req.query.org_id);
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    const date = req.query.date || dayjs().format('YYYY-MM-DD');
    const assigned_user_id = req.query.assigned_user_id ? safeNumber(req.query.assigned_user_id) : null;
    const department = req.query.department || null;

    const cols = await getTableColumns('bookings');
    const tokenCol = pickColumn(cols, 'token_number', 'token_no');

    let sql = `SELECT id, org_id, user_name, user_phone,
               ${cols.has('department') ? 'department,' : ''} assigned_user_id, booking_date,
               ${tokenCol ? tokenCol + ',' : ''} 
               ${cols.has('status') ? 'status,' : ''} 
               ${cols.has('query_issue') ? 'query_issue,' : ''} 
               ${cols.has('created_at') ? 'created_at' : 'NOW() AS created_at'}
               FROM bookings
               WHERE org_id = ? AND booking_date = ?`;
    const params = [org_id, date];

    if (assigned_user_id !== null) {
      sql += ' AND assigned_user_id = ?';
      params.push(assigned_user_id);
    }
    if (department && cols.has('department')) {
      sql += ' AND department = ?';
      params.push(department);
    }
    sql += ` ORDER BY ${tokenCol ? tokenCol : 'id'} ASC`;

    const [rows] = await db.query(sql, params);
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/* ------------------------- booking details ---------------------- */
router.get('/:id', async (req, res, next) => {
  try {
    const id = safeNumber(req.params.id);
    const [rows] = await db.query('SELECT * FROM bookings WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, booking: rows[0] });
  } catch (e) { next(e); }
});

/* ----------------------------- serve ---------------------------- */
router.post('/:id/serve', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const id = safeNumber(req.params.id);
    const cols = await getTableColumns('bookings');
    if (!cols.has('status')) {
      // If no status column, just respond OK (legacy schema).
      return res.json({ ok: true, served: true });
    }

    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const b = rows[0];

    await conn.query('UPDATE bookings SET status = ? WHERE id = ?', ['served', id]);

    // Update live metrics if that table exists
    const mcols = await getTableColumns('assigned_live_metrics');
    if (mcols.size) {
      const nowServingCol = mcols.has('now_serving_token') ? 'now_serving_token' : null;
      const avgCol = mcols.has('avg_service_seconds') ? 'avg_service_seconds' : null;
      const booking_date = b.booking_date;
      const tokenCol = pickColumn(cols, 'token_number', 'token_no');

      if (nowServingCol && booking_date && tokenCol) {
        // upsert metrics row
        await conn.query(
          `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, booking_date, ${nowServingCol}, updated_at)
           VALUES (?, ?, ?, ?, NOW())
           ON DUPLICATE KEY UPDATE ${nowServingCol} = VALUES(${nowServingCol}), updated_at = NOW()`,
          [b.org_id, b.assigned_user_id, booking_date, b[tokenCol]]
        );

        // Basic avg calculation (served within today)
        if (avgCol && mcols.has('service_started_at') && cols.has('created_at')) {
          const [served] = await conn.query(
            `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS s
             FROM bookings
             WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ? AND status = 'served'`,
            [b.org_id, b.assigned_user_id, booking_date]
          );
          if (served.length) {
            const avg = Math.round(
              served.reduce((sum, r) => sum + safeNumber(r.s), 0) / Math.max(1, served.length)
            );
            await conn.query(
              `UPDATE assigned_live_metrics SET ${avgCol} = ?, updated_at = NOW()
               WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?`,
              [avg, b.org_id, b.assigned_user_id, booking_date]
            );
          }
        }
      }
    }

    await conn.commit();
    res.json({ ok: true, served: true });
  } catch (e) {
    try { await conn.rollback(); } catch {}
    next(e);
  } finally {
    conn.release();
  }
});

/* ----------------------------- cancel --------------------------- */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = safeNumber(req.params.id);
    const cols = await getTableColumns('bookings');
    if (!cols.has('status')) {
      return res.status(400).json({ ok: false, error: 'status column missing on bookings' });
    }
    await db.query('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', id]);
    res.json({ ok: true, cancelled: true });
  } catch (e) { next(e); }
});

/* ------------------------------- edit --------------------------- */
router.put('/:id', async (req, res, next) => {
  try {
    const id = safeNumber(req.params.id);
    const body = req.body || {};
    const cols = await getTableColumns('bookings');

    const pairs = [];
    const params = [];

    const mutable = [
      ['user_name', body.user_name],
      ['user_phone', body.user_phone],
      ['user_alt_phone', body.user_alt_phone],
      ['user_email', body.user_email],
      ['place', body.place],
      ['department', body.department],
      ['assigned_user_id', body.assigned_user_id],
      ['booking_date', body.booking_date],
      [pickColumn(cols, 'scheduled_at', 'booking_datetime'), body.when ? dayjs(body.when).format('YYYY-MM-DD HH:mm:ss') : null],
      ['query_issue', body.query_issue],
      ['status', body.status]
    ];

    for (const [col, val] of mutable) {
      if (col && cols.has(col) && typeof val !== 'undefined') {
        pairs.push(`${col} = ?`);
        params.push(val);
      }
    }

    if (!pairs.length) return res.json({ ok: true, updated: 0 });

    params.push(id);
    const [r] = await db.query(`UPDATE bookings SET ${pairs.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true, updated: r.affectedRows || 0 });
  } catch (e) { next(e); }
});

module.exports = router;

const express = require('express');
const dayjs = require('dayjs');
const db = require('../services/db'); // mysql2/promise pool
const router = express.Router();

const APP_URL = process.env.APP_URL || 'http://localhost:5008';
const LIVE_BASE_URL =
  process.env.LIVE_BASE_URL && process.env.LIVE_BASE_URL.startsWith('http')
    ? process.env.LIVE_BASE_URL
    : `${APP_URL}/public/status.html`;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

async function getTableColumns(table) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return new Set(rows.map(r => r.COLUMN_NAME));
}

function pickColumn(cols, preferred, fallback) {
  if (preferred && cols.has(preferred)) return preferred;
  if (fallback && cols.has(fallback)) return fallback;
  return null;
}

function num(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

function buildStatusLink(org_id, booking_id) {
  const sep = LIVE_BASE_URL.includes('?') ? '&' : '?';
  return `${LIVE_BASE_URL}${sep}org_id=${encodeURIComponent(org_id)}&booking_id=${encodeURIComponent(booking_id)}`;
}

function buildMessagingLinks(phone, statusLink) {
  const digits = String(phone || '').replace(/[^\d]/g, '');
  const msg = `Hi! Your EasyQue live status link: ${statusLink}`;
  const enc = encodeURIComponent(msg);
  return {
    whatsapp: digits ? `https://wa.me/${digits}?text=${enc}` : null,
    sms: digits ? `sms:${digits}?&body=${enc}` : null,
  };
}

/* Token generation: per org × assigned_user × day (transaction safe) */
async function nextTokenForDay(conn, tableCols, org_id, assigned_user_id, booking_date) {
  const tokenCol = pickColumn(tableCols, 'token_number', 'token_no');
  if (!tokenCol) throw new Error('Token column not found (token_number or token_no)');
  const [rows] = await conn.query(
    `SELECT COALESCE(MAX(${tokenCol}),0) AS max_tok
       FROM bookings
      WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?
      FOR UPDATE`,
    [org_id, assigned_user_id, booking_date]
  );
  return num(rows[0]?.max_tok, 0) + 1;
}

/* ------------------------------------------------------------------ */
/* Create booking                                                      */
/* Body:
{
  "org_id": 1,
  "user_name": "Raju",
  "user_phone": "918281235929",
  "user_alt_phone": null,
  "user_email": null,
  "place": "Wayanad",
  "department": "General",
  "assigned_user_id": 5,
  "when": null,                       // optional ISO datetime
  "query_issue": "Fever"
}
*/
/* ------------------------------------------------------------------ */
router.post('/', async (req, res, next) => {
  const body = req.body || {};
  const org_id = num(body.org_id);
  const assigned_user_id = num(body.assigned_user_id, 0);

  if (!org_id || !body.user_name || !body.user_phone) {
    return res.status(400).json({ ok: false, error: 'org_id, user_name and user_phone are required' });
  }

  const booking_date = dayjs().format('YYYY-MM-DD');
  const scheduled_at =
    body.when && dayjs(body.when).isValid()
      ? dayjs(body.when).format('YYYY-MM-DD HH:mm:ss')
      : null;

  const conn = await db.getConnection();
  try {
    const cols = await getTableColumns('bookings');

    // token columns (support both)
    const tokenCols = [];
    if (cols.has('token_number')) tokenCols.push('token_number');
    if (cols.has('token_no')) tokenCols.push('token_no');

    // key cols presence checks
    if (!cols.has('booking_date')) {
      throw new Error('bookings.booking_date column is required in DB');
    }
    if (tokenCols.length === 0) {
      throw new Error('bookings token column is required (token_number or token_no)');
    }

    const schedCol = pickColumn(cols, 'scheduled_at', 'booking_datetime');
    const statusCol = cols.has('status') ? 'status' : null;
    const queryIssueCol = cols.has('query_issue') ? 'query_issue' : null;
    const createdAtCol = cols.has('created_at') ? 'created_at' : null;
    const bookingNumberCol = cols.has('booking_number') ? 'booking_number' : null;

    await conn.beginTransaction();

    // compute token
    const token_value = await nextTokenForDay(conn, cols, org_id, assigned_user_id, booking_date);

    // readable booking number if column exists
    const booking_number =
      bookingNumberCol
        ? `${dayjs(booking_date).format('YYYYMMDD')}-${assigned_user_id}-${token_value}`
        : null;

    // dynamic column list (only what exists)
    const colNames = [
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
      ...tokenCols,                // write same token value to each existing token column
      bookingNumberCol,
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
      ...tokenCols.map(() => token_value),
      bookingNumberCol ? booking_number : undefined,
      statusCol ? 'pending' : undefined,
      queryIssueCol ? (body.query_issue || null) : undefined,
      createdAtCol ? null : undefined // will swap to NOW() in the SQL text
    ].filter(v => v !== undefined);

    // placeholders
    const placeholders = colNames.map(() => '?');
    let sql = `INSERT INTO bookings (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`;

    // If created_at exists, replace its placeholder with NOW()
    if (createdAtCol) {
      const idx = colNames.lastIndexOf(createdAtCol);
      placeholders[idx] = 'NOW()';
      sql = `INSERT INTO bookings (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`;
      // remove created_at value (we added null above)
      const createdIdx = values.findIndex(v => v === null);
      if (createdIdx !== -1) values.splice(createdIdx, 1);
    }

    const [r] = await conn.query(sql, values);
    const booking_id = r.insertId;

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
        ...(tokenCols.includes('token_number') ? { token_number: token_value } : {}),
        ...(tokenCols.includes('token_no') ? { token_no: token_value } : {}),
        ...(bookingNumberCol ? { booking_number } : {})
      }
    });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    next(err);
  } finally {
    conn.release();
  }
});

/* ------------------------------------------------------------------ */
/* List bookings (today by default)                                    */
/* GET /bookings?org_id=1&date=YYYY-MM-DD&assigned_user_id=5&department=Cardio */
/* ------------------------------------------------------------------ */
router.get('/', async (req, res, next) => {
  try {
    const org_id = num(req.query.org_id);
    if (!org_id) return res.status(400).json({ ok: false, error: 'org_id required' });

    const date = req.query.date || dayjs().format('YYYY-MM-DD');
    const assigned_user_id = req.query.assigned_user_id ? num(req.query.assigned_user_id) : null;
    const department = req.query.department || null;

    const cols = await getTableColumns('bookings');
    const tokenCol = pickColumn(cols, 'token_number', 'token_no');

    let sql = `SELECT id, org_id, user_name, user_phone,
               ${cols.has('department') ? 'department,' : ''} assigned_user_id, booking_date,
               ${tokenCol ? tokenCol + ',' : ''} 
               ${cols.has('booking_number') ? 'booking_number,' : ''}
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
    sql += ` ORDER BY ${tokenCol || 'id'} ASC`;

    const [rows] = await db.query(sql, params);
    res.json({ ok: true, rows });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Booking details                                                     */
/* ------------------------------------------------------------------ */
router.get('/:id', async (req, res, next) => {
  try {
    const id = num(req.params.id);
    const [rows] = await db.query('SELECT * FROM bookings WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Not found' });
    res.json({ ok: true, booking: rows[0] });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Serve booking                                                       */
/* ------------------------------------------------------------------ */
router.post('/:id/serve', async (req, res, next) => {
  const conn = await db.getConnection();
  try {
    const id = num(req.params.id);
    const cols = await getTableColumns('bookings');
    const tokenCol = pickColumn(cols, 'token_number', 'token_no');

    await conn.beginTransaction();

    const [rows] = await conn.query('SELECT * FROM bookings WHERE id = ? FOR UPDATE', [id]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ ok: false, error: 'Not found' });
    }
    const b = rows[0];

    if (cols.has('status')) {
      await conn.query('UPDATE bookings SET status = ? WHERE id = ?', ['served', id]);
    }

    // Update assigned_live_metrics if table exists
    const mcols = await getTableColumns('assigned_live_metrics');
    if (mcols.size && mcols.has('now_serving_token') && tokenCol && b.booking_date) {
      // upsert now serving
      await conn.query(
        `INSERT INTO assigned_live_metrics (org_id, assigned_user_id, booking_date, now_serving_token, updated_at)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE now_serving_token = VALUES(now_serving_token), updated_at = NOW()`,
        [b.org_id, b.assigned_user_id, b.booking_date, b[tokenCol]]
      );

      // naive avg service seconds: avg time from created_at to now for served today
      if (mcols.has('avg_service_seconds') && cols.has('created_at')) {
        const [servedRows] = await conn.query(
          `SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) AS s
             FROM bookings
            WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ? AND status = 'served'`,
          [b.org_id, b.assigned_user_id, b.booking_date]
        );
        if (servedRows.length) {
          const avg = Math.round(
            servedRows.reduce((sum, r) => sum + num(r.s), 0) / Math.max(1, servedRows.length)
          );
          await conn.query(
            `UPDATE assigned_live_metrics
                SET avg_service_seconds = ?, updated_at = NOW()
              WHERE org_id = ? AND assigned_user_id = ? AND booking_date = ?`,
            [avg, b.org_id, b.assigned_user_id, b.booking_date]
          );
        }
      }
    }

    await conn.commit();
    res.json({ ok: true, served: true });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    next(err);
  } finally {
    conn.release();
  }
});

/* ------------------------------------------------------------------ */
/* Cancel booking                                                      */
/* ------------------------------------------------------------------ */
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const id = num(req.params.id);
    const cols = await getTableColumns('bookings');
    if (!cols.has('status')) {
      return res.status(400).json({ ok: false, error: 'status column missing on bookings' });
    }
    await db.query('UPDATE bookings SET status = ? WHERE id = ?', ['cancelled', id]);
    res.json({ ok: true, cancelled: true });
  } catch (err) { next(err); }
});

/* ------------------------------------------------------------------ */
/* Edit booking                                                        */
/* ------------------------------------------------------------------ */
router.put('/:id', async (req, res, next) => {
  try {
    const id = num(req.params.id);
    const body = req.body || {};
    const cols = await getTableColumns('bookings');

    const schedCol = pickColumn(cols, 'scheduled_at', 'booking_datetime');

    const candidates = [
      ['user_name', body.user_name],
      ['user_phone', body.user_phone],
      ['user_alt_phone', body.user_alt_phone],
      ['user_email', body.user_email],
      ['place', body.place],
      ['department', body.department],
      ['assigned_user_id', body.assigned_user_id],
      ['booking_date', body.booking_date],
      [schedCol, body.when && dayjs(body.when).isValid() ? dayjs(body.when).format('YYYY-MM-DD HH:mm:ss') : null],
      ['query_issue', body.query_issue],
      ['status', body.status]
    ];

    const sets = [];
    const params = [];
    for (const [c, v] of candidates) {
      if (c && cols.has(c) && typeof v !== 'undefined') {
        sets.push(`${c} = ?`);
        params.push(v);
      }
    }

    if (!sets.length) return res.json({ ok: true, updated: 0 });

    params.push(id);
    const [r] = await db.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = ?`, params);
    res.json({ ok: true, updated: r.affectedRows || 0 });
  } catch (err) { next(err); }
});

module.exports = router;

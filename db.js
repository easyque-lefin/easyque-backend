// db.js  -- MySQL pool helper (uses mysql2/promise)
require('dotenv').config();
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'easyque',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // recommended for timezone consistency
  timezone: 'Z'
});

module.exports = {
  pool,
  /**
   * simple wrapper: returns rows
   * usage: const rows = await db.query('SELECT * FROM users WHERE id=?', [id])
   */
  query: async (sql, params = []) => {
    const [rows] = await pool.execute(sql, params);
    return rows;
  }
};

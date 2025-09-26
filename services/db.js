// services/db.js — MySQL pool + helper
require('dotenv').config();
const mysql = require('mysql2/promise');

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME
} = process.env;

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT || 3306),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: 'Z'
});

async function query(sql, params) {
  return pool.query(sql, params);
}

module.exports = {
  pool,
  query,
  getConnection: () => pool.getConnection()
};

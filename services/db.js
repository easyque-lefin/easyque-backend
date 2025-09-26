// services/db.js — MySQL pool + tiny helper
require('dotenv').config();
const mysql = require('mysql2/promise');

// Read from .env (change if your names differ)
const {
  DB_HOST = '127.0.0.1',
  DB_PORT = '3306',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'easyque'
} = process.env;

// Create a connection pool
const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Return JS Date objects in local time; use 'Z' for UTC
  timezone: 'Z'
});

// Simple wrapper so the rest of the code can do: db.query(sql, params)
async function query(sql, params) {
  return pool.query(sql, params);
}

module.exports = {
  pool,
  query,
  getConnection: () => pool.getConnection()
};

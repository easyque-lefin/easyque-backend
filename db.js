const mysql = require('mysql2/promise');
const config = require('./config');

let pool;

async function initDb() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      port: config.db.port,
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0
    });
    console.log('✅ MySQL connection pool created');
  }
  return pool;
}

async function query(sql, params) {
  const conn = await initDb();
  const [rows] = await conn.query(sql, params);
  return rows;
}

module.exports = {
  query,
  initDb
};

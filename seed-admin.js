// seed-admin.js - run once to create initial admin
require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('./db');

async function run() {
  try {
    const email = 'easyque0@gmail.com';
    const name = 'EasyQue Admin';
    const passwordPlain = 'Mylefin@141'; // change here if you want a different password
    const role = 'admin';

    // check if email exists
    const existing = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (existing && existing.length) {
      console.log('Admin already exists with id', existing[0].id);
      process.exit(0);
    }

    const hash = await bcrypt.hash(passwordPlain, 10);
    const q = 'INSERT INTO users (name, email, password, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, NOW())';
    const res = await db.query(q, [name, email, hash, role]);
    // mysql2's pool.execute returns an object-like result; result.insertId may not be returned via our wrapper
    // so we query back to confirm
    const created = await db.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    console.log('Inserted admin. row:', created[0]);
    process.exit(0);
  } catch (err) {
    console.error('seed-admin error:', err);
    process.exit(1);
  }
}

run();

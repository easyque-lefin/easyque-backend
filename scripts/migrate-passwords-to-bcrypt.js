/**
 * scripts/migrate-passwords-to-bcrypt.js
 *
 * Usage:
 *  - from project root: node scripts/migrate-passwords-to-bcrypt.js
 *
 * This script:
 *  - loads DB connection via ../db (uses your existing db.js)
 *  - finds users with a non-empty `password` column and missing `password_hash`
 *  - for each such user, generates bcrypt hash and updates the row:
 *       password_hash = <bcrypt>, password = NULL, updated_at = NOW()
 *  - logs progress and summary
 *
 * IMPORTANT: run the SQL backup steps first (users_backup)
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../db');

async function main() {
  console.log('Starting bcrypt migration script');
  try {
    const rows = await db.query("SELECT id, email, password FROM users WHERE password IS NOT NULL AND password <> ''");
    if (!rows || rows.length === 0) {
      console.log('No users with plaintext password found. Nothing to do.');
      process.exit(0);
    }
    console.log(`Found ${rows.length} users with plaintext password. Starting updates...`);

    let success = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows) {
      try {
        // double-check whether hash already exists (race-safety)
        const check = await db.query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [r.id]);
        const existingHash = (Array.isArray(check) && check.length) ? check[0].password_hash : (check && check.password_hash);
        if (existingHash) {
          console.log(`Skipping id=${r.id} (${r.email}) — already has password_hash`);
          skipped++;
          continue;
        }

        const plain = r.password;
        if (!plain || plain.trim() === '') {
          console.log(`Skipping id=${r.id} (${r.email}) — empty password`);
          skipped++;
          continue;
        }

        const hash = await bcrypt.hash(plain, 10);
        const res = await db.query('UPDATE users SET password_hash = ?, password = NULL, updated_at = NOW() WHERE id = ?', [hash, r.id]);
        console.log(`Updated id=${r.id} (${r.email}) -> password_hash set`);
        success++;
      } catch (err) {
        failed++;
        console.error(`Failed id=${r.id} (${r.email})`, err && err.message);
      }
    }

    console.log('Migration finished. summary:', { total: rows.length, success, skipped, failed });
    process.exit(0);
  } catch (err) {
    console.error('Migration script error', err && err.stack ? err.stack : err);
    process.exit(1);
  }
}

main();

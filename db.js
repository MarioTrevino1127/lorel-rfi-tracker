const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
  // Note: attachments are stored as BLOBs up to ~3MB each. MySQL's own
  // max_allowed_packet setting (server-side, not something this client config
  // controls) needs to be at least that large for uploads to succeed — most
  // managed MySQL hosts default to 4MB or more, but if attachment uploads start
  // failing in production, this is the first thing worth asking the host about.
});

async function query(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

async function getOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(191) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role ENUM('owner','consultant','gc') NOT NULL,
      display_label VARCHAR(255) NOT NULL,
      discipline VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rfis (
      id INT AUTO_INCREMENT PRIMARY KEY,
      gc_user_id INT NOT NULL,
      subject VARCHAR(500) NOT NULL,
      spec_ref VARCHAR(255) NULL,
      question TEXT NOT NULL,
      status ENUM('submitted','assigned','answered','published') NOT NULL DEFAULT 'submitted',
      assigned_consultant_id INT NULL,
      answer TEXT NULL,
      answered_by_owner TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      assigned_at TIMESTAMP NULL,
      answered_at TIMESTAMP NULL,
      published_at TIMESTAMP NULL,
      question_attachment_name VARCHAR(255) NULL,
      question_attachment_mime VARCHAR(100) NULL,
      question_attachment_data LONGBLOB NULL,
      answer_attachment_name VARCHAR(255) NULL,
      answer_attachment_mime VARCHAR(100) NULL,
      answer_attachment_data LONGBLOB NULL,
      FOREIGN KEY (gc_user_id) REFERENCES users(id),
      FOREIGN KEY (assigned_consultant_id) REFERENCES users(id)
    ) ENGINE=InnoDB;
  `);

  // Hand-rolled session store table (see session-store.js) — deliberately not using
  // a third-party MySQL session package, since the available ones drag in vulnerable
  // nested dependencies. This is simple enough to own directly.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(191) PRIMARY KEY,
      expires BIGINT NOT NULL,
      data MEDIUMTEXT NOT NULL
    ) ENGINE=InnoDB;
  `);

  // Seed the initial owner account on first run
  const ownerCount = (await getOne(`SELECT COUNT(*) AS c FROM users WHERE role = 'owner'`)).c;
  if (ownerCount === 0) {
    const username = (process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();
    const password = process.env.OWNER_PASSWORD || 'changeme123';
    const email = (process.env.OWNER_EMAIL || '').trim().toLowerCase() || null;
    const hash = bcrypt.hashSync(password, 10);
    await query(
      `INSERT INTO users (username, password_hash, role, display_label, email) VALUES (?, ?, 'owner', 'Owner', ?)`,
      [username, hash, email]
    );
    console.log(`\n[first run] Created owner account -> username: "${username}", password: "${password}"`);
    console.log(`[first run] Log in and change this password, or set OWNER_USERNAME/OWNER_PASSWORD env vars before first run.\n`);
    if (!email) {
      console.log(`[first run] No OWNER_EMAIL set — add your notification email from the "Account" page after logging in.\n`);
    }
  } else if (process.env.OWNER_EMAIL) {
    await query(
      `UPDATE users SET email = ? WHERE role = 'owner' AND (email IS NULL OR email = '')`,
      [process.env.OWNER_EMAIL.trim().toLowerCase()]
    );
  }
}

module.exports = { pool, query, getOne, initSchema };

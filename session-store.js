const session = require('express-session');

// A deliberately small MySQL session store, built directly on our own mysql2 pool.
// Avoids third-party MySQL session packages, which at the time of writing all pull
// in outdated, vulnerable nested dependencies (old express-session/cookie/mysql2
// versions bundled inside them, regardless of our own top-level versions).
class MySQLSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
    // Periodically clear expired sessions so the table doesn't grow forever.
    this.cleanupInterval = setInterval(() => this._clearExpired(), 1000 * 60 * 15);
    this.cleanupInterval.unref();
  }

  async _clearExpired() {
    try {
      await this.pool.query(`DELETE FROM sessions WHERE expires < ?`, [Date.now()]);
    } catch (err) {
      console.error('[session-store] Cleanup failed:', err.message);
    }
  }

  async get(sid, callback) {
    try {
      const [rows] = await this.pool.query(`SELECT data, expires FROM sessions WHERE sid = ?`, [sid]);
      const row = rows[0];
      if (!row) return callback(null, null);
      if (row.expires < Date.now()) {
        await this.pool.query(`DELETE FROM sessions WHERE sid = ?`, [sid]);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 1000 * 60 * 60 * 12;
      const expires = Date.now() + maxAge;
      const data = JSON.stringify(sessionData);
      await this.pool.query(
        `INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
        [sid, expires, data]
      );
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await this.pool.query(`DELETE FROM sessions WHERE sid = ?`, [sid]);
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }

  async touch(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 1000 * 60 * 60 * 12;
      const expires = Date.now() + maxAge;
      await this.pool.query(`UPDATE sessions SET expires = ? WHERE sid = ?`, [expires, sid]);
      callback && callback(null);
    } catch (err) {
      callback && callback(err);
    }
  }
}

module.exports = MySQLSessionStore;

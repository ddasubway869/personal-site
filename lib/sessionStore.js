'use strict';
const { getDb } = require('../db');

module.exports = function factory(session) {
  class SqliteStore extends session.Store {
    async get(sid, cb) {
      try {
        const db  = await getDb();
        const row = await db.get('SELECT sess, expire FROM sessions WHERE sid = ?', sid);
        if (!row) return cb(null, null);
        if (Math.floor(Date.now() / 1000) > row.expire) {
          await db.run('DELETE FROM sessions WHERE sid = ?', sid);
          return cb(null, null);
        }
        cb(null, JSON.parse(row.sess));
      } catch (e) { cb(e); }
    }

    async set(sid, sess, cb) {
      try {
        const db     = await getDb();
        const expire = sess.cookie?.expires
          ? Math.floor(new Date(sess.cookie.expires) / 1000)
          : Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
        await db.run(
          `INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`,
          sid, JSON.stringify(sess), expire
        );
        cb(null);
      } catch (e) { cb(e); }
    }

    async destroy(sid, cb) {
      try {
        const db = await getDb();
        await db.run('DELETE FROM sessions WHERE sid = ?', sid);
        cb(null);
      } catch (e) { cb(e); }
    }

    touch(sid, sess, cb) { this.set(sid, sess, cb); }
  }

  // Prune expired sessions every hour
  setInterval(async () => {
    try {
      const db = await getDb();
      await db.run('DELETE FROM sessions WHERE expire < ?', Math.floor(Date.now() / 1000));
    } catch {}
  }, 60 * 60 * 1000);

  return SqliteStore;
};

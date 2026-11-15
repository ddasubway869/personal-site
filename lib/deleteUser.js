'use strict';
const { getDb } = require('../db');

// Permanently deletes an account. Picks, comments, likes, follows, community
// posts, tokens etc. are removed via ON DELETE CASCADE; feedback is kept but
// anonymised (ON DELETE SET NULL). Their login sessions and email log entries
// are removed too, and since every email is sent from the users table they
// will receive nothing further.
//
// Returns false if the user didn't exist.
async function deleteUser(userId) {
  const db   = await getDb();
  const user = await db.get('SELECT id, email FROM users WHERE id = ?', userId);
  if (!user) return false;

  try {
    await db.exec('BEGIN');
    await db.run(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`, user.id);
    await db.run('DELETE FROM email_logs WHERE recipient = ?', user.email);
    await db.run('DELETE FROM users WHERE id = ?', user.id);
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    throw err;
  }
  return true;
}

module.exports = deleteUser;

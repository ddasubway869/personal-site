'use strict';

module.exports = function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Login required.' });
  }
  next();
};

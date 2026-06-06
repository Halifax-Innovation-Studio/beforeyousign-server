'use strict';

/**
 * Require a non-empty X-User-Id header.
 * Attaches req.userId for downstream middleware and routes.
 */
function requireIdentity(req, res, next) {
  const userId = req.headers['x-user-id'];

  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return res.status(401).json({ error: 'X-User-Id header is required.' });
  }

  req.userId = userId.trim();
  next();
}

module.exports = requireIdentity;

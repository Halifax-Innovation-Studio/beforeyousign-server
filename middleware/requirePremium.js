'use strict';

const pool = require('../lib/db');

/**
 * Require the user to hold an active or grace-period subscription.
 * Must run after requireIdentity (depends on req.userId).
 */
async function requirePremium(req, res, next) {
  if (!req.userId) {
    return res.status(401).json({ error: 'Identity required.' });
  }

  try {
    const result = await pool.query(
      'SELECT subscription_status FROM users WHERE id = $1',
      [req.userId],
    );

    const row = result.rows[0];
    const status = row?.subscription_status ?? 'none';
    const isPremium = status === 'active' || status === 'grace';

    if (!isPremium) {
      return res.status(403).json({
        error: 'Premium subscription required.',
        subscriptionStatus: status,
      });
    }

    req.subscriptionStatus = status;
    next();
  } catch (err) {
    const detail = { message: err.message };
    if (err.code) detail.code = err.code;
    console.error('[requirePremium] DB error', detail);
    return res.status(500).json({ error: 'Failed to verify subscription.' });
  }
}

module.exports = requirePremium;

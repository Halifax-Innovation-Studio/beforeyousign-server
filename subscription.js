/**
 * server-reference/routes/subscription.js
 *
 * Phase 1 subscription route handlers for beforeyousign-server.
 * Written as Express.js middleware; adapt to whichever framework is in use.
 *
 * Dependencies to add to beforeyousign-server:
 *   npm install @apple/app-store-server-library pg
 *
 * Required environment variables on the server:
 *   APPLE_BUNDLE_ID            com.beforeyousign.leases
 *   APPLE_ENVIRONMENT          Sandbox | Production
 *   APPLE_ISSUER_ID            From App Store Connect → Keys
 *   APPLE_KEY_ID               From App Store Connect → Keys
 *   APPLE_PRIVATE_KEY          Contents of the .p8 file (single line, newlines as \n)
 *   DATABASE_URL               PostgreSQL connection string
 *
 * Mount in your Express app:
 *   const subscriptionRoutes = require('./routes/subscription');
 *   app.use('/api/subscription', subscriptionRoutes);
 *
 * POST /ocr is unchanged and does NOT require these routes.
 */

'use strict';

const express = require('express');
const { Pool } = require('pg');
const {
  AppStoreServerAPIClient,
  Environment,
  SignedDataVerifier,
} = require('@apple/app-store-server-library');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ---------------------------------------------------------------------------
// Apple verifier (initialised once at startup)
// ---------------------------------------------------------------------------

const APPLE_ROOT_CERTS = []; // populated below

/**
 * Lazily-built verifier. Separated so startup doesn't block on cert load.
 * @returns {SignedDataVerifier}
 */
function buildVerifier() {
  if (!process.env.APPLE_BUNDLE_ID) {
    throw new Error('APPLE_BUNDLE_ID is not set');
  }
  const environment =
    process.env.APPLE_ENVIRONMENT === 'Production'
      ? Environment.PRODUCTION
      : Environment.SANDBOX;

  return new SignedDataVerifier(
    APPLE_ROOT_CERTS,
    true, // enableOnlineChecks
    environment,
    process.env.APPLE_BUNDLE_ID,
    null, // appAppleId — set to numeric App ID if known
  );
}

let _verifier = null;
function getVerifier() {
  if (!_verifier) {
    _verifier = buildVerifier();
  }
  return _verifier;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode the JWS payload (middle base64url segment) without signature
 * verification, purely to read originalTransactionId before full validation.
 * Full validation is done by SignedDataVerifier.
 */
function decodeJwsPayloadUnsafe(jws) {
  try {
    const parts = jws.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

const PRODUCT_ID = 'before_you_sign_premium_monthly';

/**
 * Validate a single JWS and return the decoded transaction, or null if
 * invalid / wrong product.
 */
async function validateTransaction(jws) {
  try {
    const verifier = getVerifier();
    const transaction = await verifier.verifyAndDecodeTransaction(jws);
    if (transaction.productId !== PRODUCT_ID) return null;
    return transaction;
  } catch {
    return null;
  }
}

/**
 * From an array of validated transactions, pick the one with the latest
 * non-expired expiresDate. Returns null if no active entitlement found.
 */
function pickBestEntitlement(transactions) {
  const now = Date.now();
  const active = transactions
    .filter((t) => t && t.expiresDate && t.expiresDate > now)
    .sort((a, b) => b.expiresDate - a.expiresDate);
  return active[0] ?? null;
}

// ---------------------------------------------------------------------------
// Route: GET /api/subscription/status
// ---------------------------------------------------------------------------

router.get('/status', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'X-User-Id header is required' });
  }

  try {
    const result = await pool.query(
      'SELECT subscription_status, subscription_product_id, subscription_expires_at FROM users WHERE id = $1',
      [userId],
    );

    if (result.rows.length === 0) {
      // No row — return default without inserting.
      return res.json({
        subscriptionStatus: 'none',
        subscriptionProductId: null,
        subscriptionExpiresAt: null,
      });
    }

    const row = result.rows[0];
    return res.json({
      subscriptionStatus: row.subscription_status,
      subscriptionProductId: row.subscription_product_id ?? null,
      subscriptionExpiresAt: row.subscription_expires_at
        ? row.subscription_expires_at.toISOString()
        : null,
    });
  } catch (err) {
    console.error('[subscription/status]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Route: POST /api/subscription/verify
// Handles both new purchases (1-element array) and restores (n-element array).
// ---------------------------------------------------------------------------

router.post('/verify', async (req, res) => {
  const userId = req.headers['x-user-id'];
  if (!userId) {
    return res.status(400).json({ error: 'X-User-Id header is required' });
  }

  const { signedTransactions } = req.body;
  if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
    return res.status(400).json({ error: 'signedTransactions must be a non-empty array' });
  }

  try {
    // Validate all provided transactions with Apple.
    const validated = await Promise.all(
      signedTransactions.map((jws) => validateTransaction(jws)),
    );

    const best = pickBestEntitlement(validated.filter(Boolean));

    if (!best) {
      // All transactions validated but none are currently active.
      // Upsert with expired status so the user's row exists for future restores.
      const firstDecoded = decodeJwsPayloadUnsafe(signedTransactions[0]);
      const originalTxId = firstDecoded?.originalTransactionId ?? null;

      await upsertUser(userId, {
        subscriptionStatus: 'expired',
        subscriptionProductId: PRODUCT_ID,
        subscriptionExpiresAt: null,
        originalTransactionId: originalTxId,
      });

      return res.json({
        subscriptionStatus: 'expired',
        subscriptionProductId: PRODUCT_ID,
        subscriptionExpiresAt: null,
      });
    }

    const expiresAt = new Date(best.expiresDate).toISOString();

    await upsertUser(userId, {
      subscriptionStatus: 'active',
      subscriptionProductId: PRODUCT_ID,
      subscriptionExpiresAt: expiresAt,
      originalTransactionId: best.originalTransactionId,
    });

    return res.json({
      subscriptionStatus: 'active',
      subscriptionProductId: PRODUCT_ID,
      subscriptionExpiresAt: expiresAt,
    });
  } catch (err) {
    console.error('[subscription/verify]', err);
    return res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// DB helper
// ---------------------------------------------------------------------------

/**
 * Upsert the users row for the given userId.
 *
 * Reinstall recovery: if apple_original_transaction_id already belongs to a
 * different userId row, update that row's id to the new userId (the old UUID
 * is permanently lost on device; the subscription should follow the Apple ID).
 */
async function upsertUser(userId, { subscriptionStatus, subscriptionProductId, subscriptionExpiresAt, originalTransactionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Check if this Apple original transaction ID already belongs to another user.
    if (originalTransactionId) {
      const existing = await client.query(
        'SELECT id FROM users WHERE apple_original_transaction_id = $1 AND id != $2',
        [originalTransactionId, userId],
      );
      if (existing.rows.length > 0) {
        // Migrate the existing row to the new userId (reinstall scenario).
        await client.query(
          'UPDATE users SET id = $1 WHERE apple_original_transaction_id = $2',
          [userId, originalTransactionId],
        );
        // Now update the migrated row with fresh subscription data.
        await client.query(
          `UPDATE users SET
            subscription_status      = $1,
            subscription_product_id  = $2,
            subscription_expires_at  = $3,
            last_verified_at         = NOW()
           WHERE id = $4`,
          [subscriptionStatus, subscriptionProductId, subscriptionExpiresAt, userId],
        );
        await client.query('COMMIT');
        return;
      }
    }

    // Standard upsert.
    await client.query(
      `INSERT INTO users (
         id, subscription_status, subscription_product_id,
         subscription_expires_at, apple_original_transaction_id, last_verified_at
       ) VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         subscription_status      = EXCLUDED.subscription_status,
         subscription_product_id  = EXCLUDED.subscription_product_id,
         subscription_expires_at  = EXCLUDED.subscription_expires_at,
         apple_original_transaction_id = COALESCE(
           users.apple_original_transaction_id,
           EXCLUDED.apple_original_transaction_id
         ),
         last_verified_at         = NOW()`,
      [userId, subscriptionStatus, subscriptionProductId, subscriptionExpiresAt, originalTransactionId],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;

const https = require('https');
const express = require('express');
const { SignedDataVerifier, Environment } = require('@apple/app-store-server-library');
const pool = require('../db');

const router = express.Router();

// ---------------------------------------------------------------------------
// Apple root CA fetching (cached in memory after first call)
// ---------------------------------------------------------------------------

const APPLE_ROOT_CA_URLS = [
  'https://www.apple.com/appleca/AppleIncRootCertificate.cer',
  'https://www.apple.com/certificateauthority/AppleRootCA-G2.cer',
  'https://www.apple.com/certificateauthority/AppleRootCA-G3.cer',
];

let cachedRootCAs = null;

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

async function getAppleRootCAs() {
  if (cachedRootCAs) return cachedRootCAs;
  cachedRootCAs = await Promise.all(APPLE_ROOT_CA_URLS.map(fetchBuffer));
  return cachedRootCAs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEnvironment() {
  return process.env.NODE_ENV === 'production' ? Environment.PRODUCTION : Environment.SANDBOX;
}

function deriveStatus(tx) {
  if (tx.revocationDate) return 'expired';
  if (!tx.expiresDate) return 'active'; // non-expiring (e.g. lifetime)
  return tx.expiresDate > Date.now() ? 'active' : 'expired';
}

function buildResponse(row) {
  if (!row) {
    return {
      subscriptionStatus: 'none',
      isPremium: false,
      productId: null,
      expiresAt: null,
      lastVerifiedAt: null,
    };
  }
  const status = row.subscription_status;
  return {
    subscriptionStatus: status,
    isPremium: status === 'active' || status === 'grace',
    productId: row.subscription_product_id ?? null,
    expiresAt: row.subscription_expires_at ? new Date(row.subscription_expires_at).toISOString() : null,
    lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// GET /api/subscription/status
// Header: X-User-Id: <anonymous-user-id>
// ---------------------------------------------------------------------------

router.get('/status', async (req, res) => {
  const userId = req.headers['x-user-id'];

  if (!userId) {
    return res.status(400).json({ error: 'X-User-Id header is required.' });
  }

  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    return res.json(buildResponse(result.rows[0] ?? null));
  } catch (error) {
    console.error('Subscription status error:', error.message);
    return res.status(500).json({ error: 'Failed to retrieve subscription status.' });
  }
});

// ---------------------------------------------------------------------------
// Shared: verify JWS transactions, upsert users row, return status shape
// Used by both /verify and /restore
// ---------------------------------------------------------------------------

async function verifyAndUpsert(userId, signedTransactions) {
  const rootCAs = await getAppleRootCAs();
  const environment = getEnvironment();
  const bundleId = process.env.APPLE_BUNDLE_ID;
  const appAppleId = process.env.APPLE_APP_ID
    ? parseInt(process.env.APPLE_APP_ID, 10)
    : undefined;

  const verifier = new SignedDataVerifier(rootCAs, true, environment, bundleId, appAppleId);

  const verified = [];
  for (const signed of signedTransactions) {
    try {
      const payload = await verifier.verifyAndDecodeTransaction(signed);
      verified.push(payload);
    } catch (err) {
      console.warn('Skipping invalid signed transaction:', err.message);
    }
  }

  if (verified.length === 0) {
    const err = new Error('No valid signed transactions could be verified.');
    err.statusCode = 400;
    throw err;
  }

  // Keep only auto-renewable subscriptions, fall back to all if none found
  const subscriptions = verified.filter((tx) => tx.type === 'Auto-Renewable Subscription');
  const candidates = subscriptions.length > 0 ? subscriptions : verified;

  // Pick the best entitlement: latest expiresDate wins
  candidates.sort((a, b) => (b.expiresDate ?? 0) - (a.expiresDate ?? 0));
  const best = candidates[0];

  const subscriptionStatus = deriveStatus(best);
  const productId = best.productId ?? null;
  const expiresAt = best.expiresDate ? new Date(best.expiresDate) : null;
  const originalTransactionId = best.originalTransactionId ?? null;
  const now = new Date();

  await pool.query(
    `INSERT INTO users (
       id,
       subscription_status,
       subscription_product_id,
       subscription_expires_at,
       apple_original_transaction_id,
       last_verified_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       subscription_status           = EXCLUDED.subscription_status,
       subscription_product_id       = EXCLUDED.subscription_product_id,
       subscription_expires_at       = EXCLUDED.subscription_expires_at,
       apple_original_transaction_id = EXCLUDED.apple_original_transaction_id,
       last_verified_at              = EXCLUDED.last_verified_at`,
    [userId, subscriptionStatus, productId, expiresAt, originalTransactionId, now]
  );

  return {
    subscriptionStatus,
    isPremium: subscriptionStatus === 'active' || subscriptionStatus === 'grace',
    productId,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    lastVerifiedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /api/subscription/verify
// Header: X-User-Id: <anonymous-user-id>
// Body:   { "signedTransactions": ["..."] }
// ---------------------------------------------------------------------------

router.post('/verify', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { signedTransactions } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'X-User-Id header is required.' });
  }

  if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
    return res.status(400).json({ error: 'signedTransactions must be a non-empty array.' });
  }

  try {
    const result = await verifyAndUpsert(userId, signedTransactions);
    return res.json(result);
  } catch (error) {
    console.error('Subscription verify error:', error.message);
    const status = error.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? error.message : 'Subscription verification failed.';
    return res.status(status).json({ error: message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/subscription/restore
// Header: X-User-Id: <anonymous-user-id>
// Body:   { "signedTransactions": ["..."] }
// ---------------------------------------------------------------------------

router.post('/restore', async (req, res) => {
  const userId = req.headers['x-user-id'];
  const { signedTransactions } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'X-User-Id header is required.' });
  }

  if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
    return res.status(400).json({ error: 'signedTransactions must be a non-empty array.' });
  }

  try {
    const result = await verifyAndUpsert(userId, signedTransactions);
    return res.json(result);
  } catch (error) {
    console.error('Subscription restore error:', error.message);
    const status = error.statusCode === 400 ? 400 : 500;
    const message = status === 400 ? error.message : 'Subscription restore failed.';
    return res.status(status).json({ error: message });
  }
});

module.exports = router;

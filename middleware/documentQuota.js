'use strict';

const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Rule 1 — IP rate limit: 10 attempts/hour/IP
// Runs first, before identity or file parsing, to block brute-force cheaply.
// ---------------------------------------------------------------------------

const ipRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  keyGenerator: (req) => req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many PDF review attempts from this IP address. Please try again later.' },
  skipFailedRequests: false,
});

// ---------------------------------------------------------------------------
// Rules 2 & 3 — Per-user UTC-day counters: 3 reviews/day, 45 MB/day
//
// In-memory store. Resets automatically when the UTC date advances.
// Map<userId, { date: string, count: number, bytes: number }>
// ---------------------------------------------------------------------------

const MAX_DAILY_REVIEWS = 3;
const MAX_DAILY_BYTES = 45 * 1024 * 1024; // 45 MB

const dailyStore = new Map();

function utcDateString() {
  return new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

function getUserQuota(userId) {
  const today = utcDateString();
  let entry = dailyStore.get(userId);
  if (!entry || entry.date !== today) {
    entry = { date: today, count: 0, bytes: 0 };
    dailyStore.set(userId, entry);
  }
  return entry;
}

/**
 * Check the 3-reviews/day limit before the file is parsed.
 * Must run after requireIdentity (needs req.userId).
 */
function checkDailyReviewCount(req, res, next) {
  const quota = getUserQuota(req.userId);
  if (quota.count >= MAX_DAILY_REVIEWS) {
    return res.status(429).json({
      error: `Daily PDF review limit reached (${MAX_DAILY_REVIEWS} per day). Resets at midnight UTC.`,
    });
  }
  next();
}

/**
 * Check the 45-MB/day limit and acquire the concurrency lock.
 * Must run after multer has parsed the file (needs req.file.size).
 *
 * Commits quota only when both checks pass. Releases the concurrency lock
 * when the response closes, regardless of success or failure.
 */
function checkBytesAndLock(req, res, next) {
  if (!req.file) {
    return next(); // missing file reported by the route handler
  }

  const quota = getUserQuota(req.userId);
  const fileBytes = req.file.size;

  if (quota.bytes + fileBytes > MAX_DAILY_BYTES) {
    return res.status(429).json({
      error: `Daily upload limit reached (45 MB per day). Resets at midnight UTC.`,
    });
  }

  // Rule 4 — concurrency: 1 active review per userId
  if (activeReviews.has(req.userId)) {
    return res.status(429).json({
      error: 'A PDF review is already in progress for your account. Please wait for it to complete.',
    });
  }

  // All checks passed — commit quota and acquire lock.
  quota.count += 1;
  quota.bytes += fileBytes;
  activeReviews.add(req.userId);

  // Release the concurrency lock when the response finishes (success or error).
  const release = () => activeReviews.delete(req.userId);
  res.on('finish', release);
  res.on('close', release);

  next();
}

// ---------------------------------------------------------------------------
// Rule 4 — Concurrency lock: 1 active review per userId
// Managed inside checkBytesAndLock above; exported separately for clarity.
// ---------------------------------------------------------------------------

const activeReviews = new Set();

module.exports = { ipRateLimit, checkDailyReviewCount, checkBytesAndLock };

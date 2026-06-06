'use strict';

const express = require('express');

const requireIdentity = require('../middleware/requireIdentity');
const requirePremium = require('../middleware/requirePremium');
const { ipRateLimit, checkDailyReviewCount, checkBytesAndLock } = require('../middleware/documentQuota');
const { upload, extractTextFromBuffer, looksLikeRentalLease } = require('../lib/documentExtract');
const { analyzeLeaseText } = require('../lib/leaseAnalysis');

const router = express.Router();

// ---------------------------------------------------------------------------
// POST /pdf-review/analyze
//
// Middleware order (fail-fast, cheapest first):
//   1. ipRateLimit        — 10 attempts/hour/IP, before any identity work
//   2. requireIdentity    — X-User-Id header → req.userId
//   3. requirePremium     — subscription_status must be active or grace
//   4. checkDailyReviewCount — 3 reviews/day/user, before file is parsed
//   5. upload.single      — multer parses the PDF into memory (max 15 MB)
//   6. checkBytesAndLock  — 45 MB/day/user + 1 active review/user
//   7. handler            — text extraction → lease validation → AI analysis
//
// Headers:
//   X-User-Id: <anonymous-user-id>   (required)
//
// Body (multipart/form-data):
//   file: <pdf>                       (required, max 15 MB)
//
// Response:
//   { combinedText: string, findings: Finding[] }
// ---------------------------------------------------------------------------

router.post(
  '/analyze',
  ipRateLimit,
  requireIdentity,
  requirePremium,
  checkDailyReviewCount,
  upload.single('file'),
  checkBytesAndLock,
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file provided. Send a PDF as form-data field "file".' });
    }

    let combinedText;

    try {
      combinedText = await extractTextFromBuffer(req.file.buffer);
    } catch (err) {
      console.error('[pdf-review] PDF extraction error:', err.message);
      return res.status(422).json({ error: 'Could not extract text from the uploaded PDF.' });
    }

    if (!combinedText || combinedText.trim().length < 50 || !looksLikeRentalLease(combinedText)) {
      return res.status(400).json({
        error:
          'This does not appear to be a rental lease, or the PDF contains no readable text. Please upload a clear, text-based lease PDF.',
      });
    }

    console.log(`[pdf-review] Analyzing lease for user ${req.userId} (${combinedText.length} chars)`);

    let findings;

    try {
      findings = await analyzeLeaseText(combinedText);
    } catch (err) {
      console.error('[pdf-review] AI analysis error:', err.message);
      return res.status(500).json({ error: 'Lease analysis failed.', details: err.message });
    }

    return res.json({ combinedText, findings });
  },
);

// ---------------------------------------------------------------------------
// Multer error handler — file type and size rejections surface here
// ---------------------------------------------------------------------------

router.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'PDF exceeds the 15 MB size limit.' });
  }
  if (err?.message === 'Only PDF files are accepted.') {
    return res.status(415).json({ error: err.message });
  }
  console.error('[pdf-review] Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error.' });
});

module.exports = router;

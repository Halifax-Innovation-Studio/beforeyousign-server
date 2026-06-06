'use strict';

const multer = require('multer');
const pdfParse = require('pdf-parse');

const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter(_req, file, cb) {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are accepted.'));
    }
  },
});

const LEASE_TERMS = [
  'lease',
  'tenant',
  'landlord',
  'rent',
  'rental',
  'premises',
  'security deposit',
  'damage deposit',
  'term',
  'occupancy',
  'unit',
  'apartment',
  'residential',
];

function looksLikeRentalLease(text) {
  const lower = text.toLowerCase();
  const matches = LEASE_TERMS.filter((term) => lower.includes(term));
  return matches.length >= 3;
}

/**
 * Extract plain text from an in-memory PDF buffer.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractTextFromBuffer(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

module.exports = { upload, extractTextFromBuffer, looksLikeRentalLease };

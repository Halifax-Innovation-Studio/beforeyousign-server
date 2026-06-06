'use strict';

const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ANALYSIS_PROMPT = `
You are helping a renter understand an apartment lease.

Important:
- Do not provide legal advice.
- Provide educational information only.
- Use plain English.
- Focus on clauses an average renter should understand before signing.
- If you are unsure, say it should be reviewed with a qualified professional.
- Include page references when possible.

Review the lease text below and identify:
- important clauses
- automatic renewal terms
- notice requirements
- unusual fees
- penalties
- pet restrictions
- maintenance responsibilities
- landlord entry rights
- tenant obligations
- early termination language
- security deposit terms
- anything a renter should ask questions about

Return valid JSON only in this exact format:

{
  "findings": [
    {
      "title": "Short clause title",
      "severity": "Common / Worth Reviewing / Potential Gotcha / Important",
      "why": "Plain-English explanation of why this matters.",
      "question": "A practical question the renter should ask.",
      "page": "Page number or Unknown"
    }
  ]
}

Lease text:

`;

/**
 * Run the lease analysis against the given text using GPT-4.1-mini.
 * Returns an array of finding objects. Returns [] if parsing fails.
 *
 * @param {string} leaseText
 * @returns {Promise<Array>}
 */
async function analyzeLeaseText(leaseText) {
  const response = await openai.responses.create({
    model: 'gpt-4.1-mini',
    input: ANALYSIS_PROMPT + leaseText,
  });

  try {
    const parsed = JSON.parse(response.output_text || '{}');
    return Array.isArray(parsed.findings) ? parsed.findings : [];
  } catch (err) {
    console.error('[leaseAnalysis] Failed to parse findings JSON:', err.message);
    return [];
  }
}

module.exports = { analyzeLeaseText };

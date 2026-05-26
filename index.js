require('dotenv').config();

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/ocr', async (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        error: 'No images provided.',
      });
    }

    const pageResults = [];

    for (let i = 0; i < images.length; i++) {
      console.log(`Processing page ${i + 1} of ${images.length}`);

      const response = await openai.responses.create({
        model: 'gpt-4.1-mini',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text:
                  'Extract all readable text from this apartment lease page. Return only the extracted text. Preserve formatting as much as possible. If text is unclear, mark it as [unclear].',
              },
              {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${images[i]}`,
              },
            ],
          },
        ],
      });

      pageResults.push({
        pageNumber: i + 1,
        text: response.output_text || '',
      });
    }

    const combinedText = pageResults
      .map((page) => `Page ${page.pageNumber}:\n${page.text}`)
      .join('\n\n');

    console.log('Analyzing lease clauses...');

    const analysisResponse = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: `
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

${combinedText}
`,
    });

    let findings = [];

    try {
      const parsed = JSON.parse(analysisResponse.output_text || '{}');
      findings = Array.isArray(parsed.findings) ? parsed.findings : [];
    } catch (error) {
      console.error('Failed to parse findings JSON:', error.message);
      findings = [];
    }

    res.json({
      pages: pageResults,
      combinedText,
      findings,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'OCR failed.',
      details: error.message,
    });
  }
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OCR server running on port ${PORT}`);
});
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
                  'Extract all readable text from this apartment lease page. Return only the extracted text. Preserve formatting as much as possible.',
              },
              {
                type: 'input_image',
                image_url: `data:image/jpeg;base64,${images[i]}`,
              },
            ],
          },
        ],
      });

      const extractedText = response.output_text || '';

      pageResults.push({
        pageNumber: i + 1,
        text: extractedText,
      });
    }

    const combinedText = pageResults
      .map(
        (page) =>
          `Page ${page.pageNumber}:\n${page.text}`
      )
      .join('\n\n');

    res.json({
      pages: pageResults,
      combinedText,
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
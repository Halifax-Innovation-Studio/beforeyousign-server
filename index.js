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

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/ocr', async (req, res) => {
  try {
    const { images } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'No images provided.' });
    }

    const content = [
      {
        type: 'input_text',
        text:
          'Extract the readable text from these apartment lease images. Return only the extracted text. Preserve page order. If text is unclear, mark it as [unclear].',
      },
      ...images.map((base64Image) => ({
        type: 'input_image',
        image_url: `data:image/jpeg;base64,${base64Image}`,
      })),
    ];

    const response = await openai.responses.create({
      model: 'gpt-4.1-mini',
      input: [
        {
          role: 'user',
          content,
        },
      ],
    });

    res.json({
      text: response.output_text || '',
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
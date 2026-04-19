'use strict';

const express = require('express');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/**
 * POST /ask
 * Body: { "query": "your question here" }
 * Retrieves relevant context from the knowledge base and queries the AI.
 */
app.post('/ask', async (req, res) => {
  const { query } = req.body;

  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'Request body must include a non-empty "query" string.' });
  }

  try {
    const result = await rag.ask(query.trim());
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: `OpenClaw RAG error: ${err.message}` });
  }
});

/**
 * POST /analyze
 * Body: { "text": "text to analyze" }
 * Analyzes the text and returns structured feedback JSON.
 */
app.post('/analyze', async (req, res) => {
  const { text } = req.body;

  if (!text || typeof text !== 'string' || text.trim() === '') {
    return res.status(400).json({ error: 'Request body must include a non-empty "text" string.' });
  }

  try {
    const result = await feedback.analyze(text.trim());
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ error: `OpenClaw Feedback error: ${err.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PincerX API running on http://localhost:${PORT}`);
  });
}

module.exports = app;

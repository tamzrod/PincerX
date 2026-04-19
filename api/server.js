'use strict';

const express = require('express');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/**
 * Validate that a request field is a non-empty string.
 *
 * @param {*} value - The value to validate.
 * @param {string} fieldName - Field name used in the error message.
 * @returns {string|null} Error message string, or null if valid.
 */
function validateStringField(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `Request body must include a non-empty "${fieldName}" string.`;
  }
  return null;
}

/**
 * POST /ask
 * Body: { "query": "your question here" }
 * Retrieves relevant context from the knowledge base and queries the AI.
 */
app.post('/ask', async (req, res) => {
  const { query } = req.body;
  const err = validateStringField(query, 'query');
  if (err) return res.status(400).json({ error: err });

  try {
    const result = await rag.ask(query.trim());
    return res.json(result);
  } catch (e) {
    return res.status(502).json({ error: `OpenClaw RAG error: ${e.message}` });
  }
});

/**
 * POST /analyze
 * Body: { "text": "text to analyze" }
 * Analyzes the text and returns structured feedback JSON.
 */
app.post('/analyze', async (req, res) => {
  const { text } = req.body;
  const err = validateStringField(text, 'text');
  if (err) return res.status(400).json({ error: err });

  try {
    const result = await feedback.analyze(text.trim());
    return res.json(result);
  } catch (e) {
    return res.status(502).json({ error: `OpenClaw Feedback error: ${e.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PincerX API running on http://localhost:${PORT}`);
  });
}

module.exports = app;

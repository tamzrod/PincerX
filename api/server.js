'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');
const { ingest } = require('../ingest');

const app = express();
const PORT = process.env.PORT || 3000;

const PDF_DIR = path.join(__dirname, '..', 'pdfs');

// Ensure the pdfs directory exists at startup
fs.mkdirSync(PDF_DIR, { recursive: true });

// Multer storage: save to /pdfs with original filename
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PDF_DIR),
  filename: (_req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.pdf') {
      return cb(new Error('Only PDF files are allowed.'));
    }
    cb(null, true);
  },
});

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

/**
 * POST /upload
 * Accepts a PDF file (multipart/form-data, field name "file"),
 * saves it to /pdfs, and rebuilds the knowledge base.
 */
app.post('/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'A PDF file must be provided in the "file" field.' });
    }

    try {
      await ingest();
      return res.json({ message: `Uploaded ${req.file.originalname} and rebuilt knowledge base.` });
    } catch (e) {
      return res.status(500).json({ error: `Ingestion failed: ${e.message}` });
    }
  });
});

/**
 * DELETE /pdf
 * Body: { "filename": "example.pdf" }
 * Deletes the specified PDF from /pdfs and rebuilds the knowledge base.
 */
app.delete('/pdf', async (req, res) => {
  const { filename } = req.body;
  const err = validateStringField(filename, 'filename');
  if (err) return res.status(400).json({ error: err });

  // Prevent path traversal: only allow plain filenames with no directory separators
  if (path.basename(filename) !== filename || !filename.toLowerCase().endsWith('.pdf')) {
    return res.status(400).json({ error: 'Invalid filename. Must be a plain .pdf filename.' });
  }

  const filePath = path.join(PDF_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filename}` });
  }

  try {
    fs.unlinkSync(filePath);
    await ingest();
    return res.json({ message: `Deleted ${filename} and rebuilt knowledge base.` });
  } catch (e) {
    return res.status(500).json({ error: `Operation failed: ${e.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PincerX API running on http://localhost:${PORT}`);
  });
}

module.exports = app;

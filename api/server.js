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
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');

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
app.use(express.static(path.join(__dirname, '..', 'public')));

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
 * GET /config
 * Returns the current AI configuration (baseUrl, model, and whether an API key is stored).
 */
app.get('/config', (_req, res) => {
  let stored = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    return res.status(500).json({ error: `Could not read config: ${e.message}` });
  }
  return res.json({
    baseUrl: stored.baseUrl || process.env.AI_BASE_URL || 'http://localhost:11434',
    model: stored.model || process.env.AI_MODEL || 'llama3',
    hasApiKey: Boolean(stored.apiKey || process.env.AI_API_KEY),
  });
});

/**
 * POST /config
 * Body: { "baseUrl": "http://192.168.1.10:11434", "model": "llama3.2", "apiKey": "sk-..." }
 * Saves AI configuration to data/ai-config.json.
 * Omit apiKey to keep the existing stored key; send an empty string to clear it.
 */
app.post('/config', (req, res) => {
  const { baseUrl, model, apiKey } = req.body;

  const urlErr = validateStringField(baseUrl, 'baseUrl');
  if (urlErr) return res.status(400).json({ error: urlErr });

  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    return res.status(400).json({ error: 'baseUrl must be a valid URL (e.g. http://192.168.1.10:11434).' });
  }

  let config = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch { /* start fresh if file is corrupt */ }

  config.baseUrl = baseUrl.trim();

  if (typeof model === 'string' && model.trim()) {
    config.model = model.trim();
  }

  // Only update apiKey if the caller included it in the request body
  if ('apiKey' in req.body) {
    config.apiKey = typeof apiKey === 'string' ? apiKey : '';
  }

  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return res.json({ message: 'Configuration saved.' });
  } catch (e) {
    return res.status(500).json({ error: `Could not save config: ${e.message}` });
  }
});

/**
 * GET /pdfs
 * Returns a list of PDF filenames currently stored in /pdfs.
 */
app.get('/pdfs', async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(PDF_DIR);
    const files = entries.filter((f) => f.toLowerCase().endsWith('.pdf'));
    return res.json({ files });
  } catch (e) {
    return res.status(500).json({ error: `Could not list PDFs: ${e.message}` });
  }
});

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
      if (e.code === 'INGESTION_IN_PROGRESS') {
        return res.status(409).json({ error: e.message });
      }
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
    if (e.code === 'INGESTION_IN_PROGRESS') {
      return res.status(409).json({ error: e.message });
    }
    return res.status(500).json({ error: `Operation failed: ${e.message}` });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PincerX API running on http://localhost:${PORT}`);
  });
}

module.exports = app;

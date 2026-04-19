'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');
const ai = require('../openclaw/ai');
const { ingest, SUPPORTED_EXTENSIONS } = require('../ingest');

const app = express();
const PORT = process.env.PORT || 3000;

const PDF_DIR = path.join(__dirname, '..', 'pdfs');
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');

// Ensure required directories exist at startup
fs.mkdirSync(PDF_DIR, { recursive: true });
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });

// Multer storage: save to /pdfs with original filename
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PDF_DIR),
  filename: (_req, file, cb) => cb(null, file.originalname),
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(file.originalname).toLowerCase())) {
      return cb(new Error(`Unsupported file type. Allowed: ${[...SUPPORTED_EXTENSIONS].join(', ')}`));
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
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    return res.json({ message: 'Configuration saved.' });
  } catch (e) {
    return res.status(500).json({ error: `Could not save config: ${e.message}` });
  }
});

/**
 * GET /models?baseUrl=http://192.168.1.10:11434
 * Proxies a request to the Ollama-compatible backend's /api/tags endpoint
 * and returns the list of available model names.
 */
app.get('/models', async (req, res) => {
  let { baseUrl } = req.query;
  if (!baseUrl) {
    // Fall back to the currently configured baseUrl
    try {
      const stored = fs.existsSync(CONFIG_PATH)
        ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
        : {};
      baseUrl = stored.baseUrl || process.env.AI_BASE_URL || 'http://localhost:11434';
    } catch {
      baseUrl = process.env.AI_BASE_URL || 'http://localhost:11434';
    }
  }

  let tagsUrl;
  try {
    tagsUrl = new URL('/api/tags', baseUrl).toString();
  } catch {
    return res.status(400).json({ error: 'Invalid baseUrl.' });
  }

  try {
    const response = await fetch(tagsUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(502).json({ error: `Backend returned HTTP ${response.status}` });
    }
    const data = await response.json();
    const models = Array.isArray(data.models)
      ? data.models.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean)
      : [];
    return res.json({ models });
  } catch (e) {
    return res.status(502).json({ error: `Could not reach AI backend: ${e.message}` });
  }
});

/**
 * GET /pdfs
 * Returns a list of supported filenames currently stored in /pdfs.
 */
app.get('/pdfs', async (_req, res) => {
  try {
    const entries = await fs.promises.readdir(PDF_DIR);
    const files = entries.filter((f) => SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()));
    return res.json({ files });
  } catch (e) {
    return res.status(500).json({ error: `Could not list files: ${e.message}` });
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
 * Deletes the specified file from /pdfs and rebuilds the knowledge base.
 */
app.delete('/pdf', async (req, res) => {
  const { filename } = req.body;
  const err = validateStringField(filename, 'filename');
  if (err) return res.status(400).json({ error: err });

  // Prevent path traversal: only allow plain filenames with no directory separators
  if (path.basename(filename) !== filename || !SUPPORTED_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
    return res.status(400).json({ error: `Invalid filename. Must be a plain filename with a supported extension (${[...SUPPORTED_EXTENSIONS].join(', ')}).` });
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
  app.listen(PORT, async () => {
    console.log(`PincerX API running on http://localhost:${PORT}`);

    // Validate configured AI model against available models at startup.
    try {
      let stored = {};
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
      } catch { /* ignore corrupt config */ }

      const baseUrl = stored.baseUrl || process.env.AI_BASE_URL || 'http://localhost:11434';
      const configuredModel = stored.model || process.env.AI_MODEL || 'llama3';
      const models = await ai.listModels({ baseUrl });

      if (models.length > 0 && !models.includes(configuredModel)) {
        console.warn(`[AI] Configured model "${configuredModel}" not found in available models list. Available: ${models.join(', ')}`);
      }
    } catch (e) {
      console.error('[AI] Could not validate model on startup:', e.message);
    }
  });
}

module.exports = app;

'use strict';

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');
const ai = require('../openclaw/ai');
const { ingest } = require('../ingest');
const story = require('../story/story');

const app = express();
const PORT = process.env.PORT || 3000;

const PDF_DIR = path.join(__dirname, '..', 'pdfs');
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');
const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');
const TTS_CACHE_DIR = path.join(__dirname, '..', 'data', 'tts-cache');

// Ensure required directories exist at startup
fs.mkdirSync(PDF_DIR, { recursive: true });
fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.mkdirSync(STORIES_DIR, { recursive: true });
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

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

/**
 * Build an informative error message for a failed fetch to the Zonos sidecar.
 *
 * Node's native fetch surfaces the real network reason in e.cause rather than
 * e.message (which is just "fetch failed"), so we prefer that when available.
 * Common cases are given actionable guidance:
 *   - ECONNREFUSED → Zonos container is not running.
 *   - TimeoutError  → model is still loading; try again shortly.
 *
 * @param {Error} e - The caught error from a failed fetch call.
 * @returns {string} A human-readable error string.
 */
function ttsFetchError(e) {
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return 'TTS service unreachable: request timed out — the Zonos model may still be loading. Wait a moment and try again.';
  }
  const detail = e.cause?.message || e.message;
  const base = `TTS service unreachable: ${detail}`;
  if (detail.includes('ECONNREFUSED')) {
    return `${base}. Is the Zonos container running? See zonos/README.md for setup instructions.`;
  }
  return base;
}

/**
 * POST /tts
 * Body: { "text": "chapter text to synthesize", "voice_id": "myVoice",
 *         "speaking_rate": 15.0, "pitch_std": 45.0, "emotion_preset": "neutral" }
 * Proxies the request to the Zonos TTS sidecar and streams back a WAV file.
 * Falls back to a 502 with a JSON error body if the sidecar is unreachable so
 * the browser can fall back to the Web Speech API gracefully.
 *
 * Generated audio is cached to disk (data/tts-cache/) keyed by a SHA-256 hash
 * of the normalised request parameters.  Subsequent requests with identical
 * parameters are served from the cache instantly without calling Zonos.
 */
const TTS_MAX_CHARS = 50_000;  // ~8 000 words – more than enough for one chapter
const TTS_TIMEOUT_MS = 180_000; // 3 min: Zonos on GPU generates ~real-time

/**
 * Build a deterministic cache key from the normalised TTS request parameters.
 *
 * @param {string} text - The (already trimmed+capped) text to synthesize.
 * @param {string} voiceId - Voice ID, or empty string for the default voice.
 * @param {number|undefined} speakingRate - Speaking rate (tokens/s).
 * @param {number|undefined} pitchStd - Pitch standard deviation.
 * @param {string} emotionPreset - Emotion preset name.
 * @returns {string} Hex SHA-256 digest usable as a filename stem.
 */
function ttsCacheKey(text, voiceId, speakingRate, pitchStd, emotionPreset) {
  const normalized = JSON.stringify({
    text,
    voice_id: voiceId || '',
    speaking_rate: typeof speakingRate === 'number' ? speakingRate : 15.0,
    pitch_std: typeof pitchStd === 'number' ? pitchStd : 45.0,
    emotion_preset: emotionPreset || 'neutral',
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

app.post('/tts', async (req, res) => {
  const { text, voice_id, speaking_rate, pitch_std, emotion_preset } = req.body;
  const err = validateStringField(text, 'text');
  if (err) return res.status(400).json({ error: err });

  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  const trimmed = text.trim().slice(0, TTS_MAX_CHARS);

  const voiceId = typeof voice_id === 'string' ? voice_id.trim() : '';
  const emotionPreset = typeof emotion_preset === 'string' ? emotion_preset.trim() : '';

  // ── Cache lookup ──────────────────────────────────────────────────────────
  const cacheKey = ttsCacheKey(trimmed, voiceId, speaking_rate, pitch_std, emotionPreset);
  const cachePath = path.join(TTS_CACHE_DIR, `${cacheKey}.wav`);

  if (fs.existsSync(cachePath)) {
    const cached = fs.readFileSync(cachePath);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(cached.length));
    res.set('X-TTS-Cache', 'hit');
    return res.send(cached);
  }

  // ── Cache miss: synthesize via Zonos ─────────────────────────────────────
  const zonosBody = { text: trimmed };
  if (voiceId) zonosBody.voice_id = voiceId;
  if (typeof speaking_rate === 'number') zonosBody.speaking_rate = speaking_rate;
  if (typeof pitch_std === 'number') zonosBody.pitch_std = pitch_std;
  if (emotionPreset) zonosBody.emotion_preset = emotionPreset;

  try {
    const response = await fetch(`${zonosUrl}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(zonosBody),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return res.status(502).json({ error: `TTS service error: ${detail}` });
    }

    const audioBuffer = await response.arrayBuffer();

    // Persist to cache so future identical requests skip Zonos entirely.
    try {
      fs.writeFileSync(cachePath, Buffer.from(audioBuffer));
    } catch (writeErr) {
      // Non-fatal: log and continue serving the audio even if caching fails.
      console.warn('[TTS cache] Failed to write cache file:', writeErr.message);
    }

    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(audioBuffer.byteLength));
    res.set('X-TTS-Cache', 'miss');
    return res.send(Buffer.from(audioBuffer));
  } catch (e) {
    return res.status(502).json({ error: ttsFetchError(e) });
  }
});

/**
 * GET /tts/voices
 * Returns available voice IDs and emotion presets from the Zonos sidecar.
 */
app.get('/tts/voices', async (_req, res) => {
  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  try {
    const response = await fetch(`${zonosUrl}/voices`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      return res.status(502).json({ error: `TTS service error: HTTP ${response.status}` });
    }
    return res.json(await response.json());
  } catch (e) {
    return res.status(502).json({ error: ttsFetchError(e) });
  }
});

/**
 * DELETE /tts/cache
 * Removes all cached TTS audio files from data/tts-cache/.
 * Call this after re-uploading a voice embedding so that stale audio generated
 * with the old embedding is not served from the cache.
 */
app.delete('/tts/cache', (_req, res) => {
  try {
    const files = fs.readdirSync(TTS_CACHE_DIR).filter((f) => f.endsWith('.wav'));
    for (const f of files) {
      fs.unlinkSync(path.join(TTS_CACHE_DIR, f));
    }
    return res.json({ message: `Cleared ${files.length} cached audio file(s).`, count: files.length });
  } catch (e) {
    return res.status(500).json({ error: `Failed to clear TTS cache: ${e.message}` });
  }
});

/**
 * POST /tts/voice
 * Multipart form-data: field "file" (audio), field "name" (voice ID, alphanumeric/underscore/dash).
 * Forwards the audio to the Zonos sidecar which computes and stores a speaker embedding.
 */
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

app.post('/tts/voice', (req, res) => {
  voiceUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'An audio file must be provided in the "file" field.' });

    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) {
      return res.status(400).json({ error: 'A valid "name" (alphanumeric, underscores, dashes) must be provided.' });
    }

    const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';

    try {
      const formData = new FormData();
      formData.append(
        'file',
        new Blob([req.file.buffer], { type: req.file.mimetype }),
        req.file.originalname,
      );

      const response = await fetch(
        `${zonosUrl}/voices/upload?name=${encodeURIComponent(name)}`,
        { method: 'POST', body: formData, signal: AbortSignal.timeout(30_000) },
      );

      if (!response.ok) {
        const detail = await response.text().catch(() => response.statusText);
        return res.status(502).json({ error: `TTS service error: ${detail}` });
      }
      return res.json(await response.json());
    } catch (e) {
      return res.status(502).json({ error: ttsFetchError(e) });
    }
  });
});

/**
 * DELETE /tts/voice/:id
 * Removes a saved voice embedding from the Zonos sidecar.
 */
app.delete('/tts/voice/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid voice ID format.' });
  }
  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  try {
    const response = await fetch(`${zonosUrl}/voices/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      return res.status(response.status === 404 ? 404 : 502).json({ error: `TTS service error: ${detail}` });
    }
    return res.json(await response.json());
  } catch (e) {
    return res.status(502).json({ error: ttsFetchError(e) });
  }
});

/**
 * POST /story/create
 * Body: { "title": "...", "genre": "...", "tone": "..." }
 * Generates a story outline via AI and saves it to data/stories/.
 */
app.post('/story/create', async (req, res) => {
  const { title, genre, tone } = req.body;

  const titleErr = validateStringField(title, 'title');
  if (titleErr) return res.status(400).json({ error: titleErr });

  const genreErr = validateStringField(genre, 'genre');
  if (genreErr) return res.status(400).json({ error: genreErr });

  const toneErr = validateStringField(tone, 'tone');
  if (toneErr) return res.status(400).json({ error: toneErr });

  try {
    const result = await story.create(title.trim(), genre.trim(), tone.trim());
    return res.status(201).json(result);
  } catch (e) {
    return res.status(502).json({ error: `Story generation error: ${e.message}` });
  }
});

/**
 * POST /story/:id/chapter
 * Body: { "chapterNumber": 1, "customPrompt": "..." }
 * Generates a chapter for an existing story and saves it to data/stories/.
 */
app.post('/story/:id/chapter', async (req, res) => {
  const { id } = req.params;
  const { chapterNumber, customPrompt } = req.body;

  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }

  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    return res.status(400).json({ error: 'Request body must include a positive integer "chapterNumber".' });
  }

  const prompt = typeof customPrompt === 'string' ? customPrompt.trim() : '';

  try {
    const result = await story.generateChapter(id, chapterNumber, {}, prompt);
    return res.status(201).json(result);
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(502).json({ error: `Chapter generation error: ${e.message}` });
  }
});

/**
 * DELETE /story/:id/chapter/:chapterNumber
 * Deletes a specific chapter from an existing story.
 */
app.delete('/story/:id/chapter/:chapterNumber', async (req, res) => {
  const { id, chapterNumber: chapterStr } = req.params;
  const chapterNumber = parseInt(chapterStr, 10);

  if (!id || !/^[a-z0-9-]+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }

  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    return res.status(400).json({ error: 'Invalid chapter number.' });
  }

  try {
    const result = await story.deleteChapter(id, chapterNumber);
    return res.json(result);
  } catch (e) {
    if (e.message.startsWith('Story not found') || e.message.startsWith('Chapter')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Delete chapter error: ${e.message}` });
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

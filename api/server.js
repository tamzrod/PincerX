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
const storyRag = require('../story/story-rag');

const app = express();
const PORT = process.env.PORT || 3000;

const PDF_DIR = path.join(__dirname, '..', 'pdfs');
const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');
const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');
const TTS_CACHE_DIR = path.join(__dirname, '..', 'data', 'tts-cache');

// Regex to validate that a TTS cache key is a SHA-256 hex digest (64 lowercase hex chars).
const SHA256_RE = /^[0-9a-f]{64}$/;

// Story ID validation regex — must stay in sync with the route-level guard.
const STORY_ID_RE = /^[a-z0-9-]+$/;

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
 * Returns the current AI configuration (baseUrl, model, provider, and whether an API key is stored).
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
    provider: stored.provider || process.env.AI_PROVIDER || 'ollama',
    hasApiKey: Boolean(stored.apiKey || process.env.AI_API_KEY),
  });
});

/**
 * POST /config
 * Body: { "baseUrl": "http://192.168.1.10:11434", "model": "llama3.2", "apiKey": "sk-...", "provider": "ollama" }
 * Saves AI configuration to data/ai-config.json.
 * Omit apiKey to keep the existing stored key; send an empty string to clear it.
 * provider must be "ollama" or "openai".
 */
app.post('/config', (req, res) => {
  const { baseUrl, model, apiKey, provider } = req.body;

  const urlErr = validateStringField(baseUrl, 'baseUrl');
  if (urlErr) return res.status(400).json({ error: urlErr });

  try {
    // eslint-disable-next-line no-new
    new URL(baseUrl);
  } catch {
    return res.status(400).json({ error: 'baseUrl must be a valid URL (e.g. http://192.168.1.10:11434).' });
  }

  const VALID_PROVIDERS = ['ollama', 'openai', 'groq', 'openrouter'];
  if (provider !== undefined && !VALID_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}.` });
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

  if (typeof provider === 'string') {
    config.provider = provider;
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
 * GET /models?baseUrl=http://192.168.1.10:11434&provider=ollama
 * Proxies a request to the AI backend to list available models.
 * For "ollama" provider: calls /api/tags (Ollama format).
 * For "openai" provider: calls /models (OpenAI-compatible format).
 */
app.get('/models', async (req, res) => {
  let { baseUrl, provider } = req.query;

  let stored = {};
  try {
    stored = fs.existsSync(CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      : {};
  } catch { /* use defaults */ }

  if (!baseUrl) {
    baseUrl = stored.baseUrl || process.env.AI_BASE_URL || 'http://localhost:11434';
  }
  if (!provider) {
    provider = stored.provider || process.env.AI_PROVIDER || 'ollama';
  }

  const isOpenAI = provider === 'openai' || provider === 'groq' || provider === 'openrouter';

  let modelsUrl;
  try {
    // Ensure base ends with "/" so the relative path appends correctly
    // (important for providers like Groq with a path prefix: /openai/v1/).
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    modelsUrl = new URL(isOpenAI ? 'models' : 'api/tags', base).toString();
  } catch {
    return res.status(400).json({ error: 'Invalid baseUrl.' });
  }

  try {
    const headers = {};
    const apiKey = stored.apiKey || process.env.AI_API_KEY || '';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const response = await fetch(modelsUrl, {
      signal: AbortSignal.timeout(8000),
      headers,
    });
    if (!response.ok) {
      return res.status(502).json({ error: `Backend returned HTTP ${response.status}` });
    }
    const data = await response.json();

    let models;
    if (isOpenAI) {
      models = Array.isArray(data.data)
        ? data.data.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean)
        : [];
    } else {
      models = Array.isArray(data.models)
        ? data.models.map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean)
        : [];
    }
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
 * Returns a 502 with a JSON error body if the sidecar is unreachable.
 *
 * Generated audio is cached to disk (data/tts-cache/) keyed by a SHA-256 hash
 * of the normalised request parameters.  Subsequent requests with identical
 * parameters are served from the cache instantly without calling Zonos.
 */
const TTS_MAX_CHARS = 50_000;  // ~8 000 words – more than enough for one chapter
const TTS_TIMEOUT_MS = 180_000; // 3 min: Zonos on GPU generates ~real-time
const PREBAKE_JOB_RETENTION_MS = 10 * 60 * 1000; // 10 min – then evict from memory
const ZONOS_STARTUP_POLL_MS    =   3_000; // poll interval while waiting for Zonos
const ZONOS_STARTUP_TIMEOUT_MS = 180_000; // give up waiting after 3 min

// Chunk size used by both the frontend player and the server-side prebake —
// must stay in sync so that cache keys computed on both sides match.
const TTS_CHUNK_MAX_CHARS = 300;

// Default Zonos voice parameters used when the caller omits them.
// These must match the defaults in the frontend's voicePrefs object.
const TTS_DEFAULT_SPEAKING_RATE = 15.0;
const TTS_DEFAULT_PITCH_STD = 45.0;

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
    speaking_rate: typeof speakingRate === 'number' ? speakingRate : TTS_DEFAULT_SPEAKING_RATE,
    pitch_std: typeof pitchStd === 'number' ? pitchStd : TTS_DEFAULT_PITCH_STD,
    emotion_preset: emotionPreset || 'neutral',
  });
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Regex matching an emotion tag at the start of a chunk (possibly preceded by
 * whitespace), used for tag extraction.  Handles both the canonical square-bracket
 * form ([emotion:preset]) and the quoted form ("emotion:preset") that some LLMs
 * emit.  The anchored ^ means this only matches a leading tag; the global
 * replacement in stripTTSTags() uses the unanchored form.  Unknown presets
 * extracted here are passed through to Zonos, which falls back to "neutral".
 */
const EMOTION_TAG_RE = /^(?:\[emotion:([a-z]+)\]|"emotion:([a-z]+)")\s*/;

/**
 * Regex matching a speaker tag at the start of a chunk, used to identify
 * whether the paragraph is narrator prose or character dialogue.
 * Accepts any alphanumeric identifier so that named character tags such as
 * [speaker:Elena] are recognised alongside the legacy [speaker:male] /
 * [speaker:female] format.
 */
const SPEAKER_TAG_RE = /^\[speaker:([A-Za-z0-9_-]+)\]\s*/;

/**
 * Generic speaker identifiers that fall back to the caller's voice and neutral
 * emotion rather than using a character-specific voice from the profile store.
 * Named character speakers (anything NOT in this list) are resolved via the
 * characterVoiceMap in startPrebakeJob.
 */
const GENERIC_SPEAKERS = new Set(['narrator', 'male', 'female']);

/**
 * Strip all speaker and emotion tags from *text*, returning clean prose suitable
 * for display or for sending directly to Zonos.  Handles the canonical
 * [speaker:X] and [emotion:X] square-bracket formats as well as the "emotion:X"
 * quoted format that some models produce when they misread the example in the prompt.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTTSTags(text) {
  return text
    .replace(/\[speaker:(narrator|male|female)\]\s*/g, '')
    .replace(/\[emotion:[a-z]+\]\s*/g, '')
    .replace(/"emotion:[a-z]+"\s*/g, '');
}

/**
 * Split *text* into sentence-sized chunks of at most *TTS_CHUNK_MAX_CHARS*
 * characters.  Mirrors the frontend splitIntoChunks() function exactly so that
 * both sides produce the same chunk list (and therefore the same cache keys).
 * NOTE: if the split regex below is changed, update the frontend copy too.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitIntoTTSChunks(text) {
  // Split on blank lines (paragraph boundaries) and sentence-ending punctuation
  // followed by whitespace and an uppercase letter or opening quote.
  // Unicode: \u201C = left double quotation mark, \u2018 = left single quote.
  const sentences = text
    .split(/\n\n+|(?<=[.!?…])\s+(?=[A-Z"'\u201C\u2018])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [text];

  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (sentence.length > TTS_CHUNK_MAX_CHARS) {
      if (current) { chunks.push(current); current = ''; }
      let remaining = sentence;
      while (remaining.length > TTS_CHUNK_MAX_CHARS) {
        const cut = remaining.lastIndexOf(' ', TTS_CHUNK_MAX_CHARS);
        const hasWordBoundary = cut > 0;
        chunks.push(hasWordBoundary ? remaining.slice(0, cut) : remaining.slice(0, TTS_CHUNK_MAX_CHARS));
        remaining = remaining.slice(hasWordBoundary ? cut + 1 : TTS_CHUNK_MAX_CHARS);
      }
      current = remaining;
    } else if (current && current.length + 1 + sentence.length > TTS_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

/**
 * Same as splitIntoTTSChunks() but returns objects with the emotion preset
 * and speaker type extracted from each chunk's leading tags.  Both tags are
 * stripped from the returned text so Zonos only receives clean prose.
 *
 * The emotion and speaker "cascade": once a tag is seen, subsequent chunks
 * inherit it until a new tag appears.  This ensures sentences that continue a
 * paragraph (after a mid-paragraph split) get the right settings.
 *
 * Speaker rules enforced here:
 *   - narrator chunks always use emotion "neutral" regardless of the emotion tag,
 *     keeping the narration voice stable and preventing sudden volume changes.
 *   - male/female character chunks use the emotion from their [emotion:X] tag.
 *
 * After tag extraction, each character-voiced chunk is further split at
 * dialogue/attribution boundaries (see splitDialogueFromAttribution) so that
 * quoted speech and its narrative attribution are voiced by the correct speaker.
 *
 * @param {string} text - Chapter content, possibly containing [speaker:X] and [emotion:X] tags.
 * @param {string} [fallbackEmotion='neutral'] - Preset used before the first tag.
 * @returns {Array<{text: string, emotion: string, speaker: string}>}
 */
function splitIntoTTSChunksWithEmotion(text, fallbackEmotion = 'neutral') {
  const rawChunks = splitIntoTTSChunks(text);
  let currentEmotion = fallbackEmotion;
  let currentSpeaker = 'narrator';
  const result = [];
  for (const chunk of rawChunks) {
    let remaining = chunk;
    // Extract speaker tag first (it precedes the emotion tag in the new format)
    const speakerMatch = remaining.match(SPEAKER_TAG_RE);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1];
      remaining = remaining.slice(speakerMatch[0].length);
    }
    // Extract emotion tag
    const emotionMatch = remaining.match(EMOTION_TAG_RE);
    if (emotionMatch) currentEmotion = emotionMatch[1] || emotionMatch[2]; // group 1 = bracket format, group 2 = quoted format
    // Narrator paragraphs always use neutral emotion to prevent volume fluctuation
    const effectiveEmotion = currentSpeaker === 'narrator' ? 'neutral' : currentEmotion;
    const baseChunk = { text: stripTTSTags(remaining), emotion: effectiveEmotion, speaker: currentSpeaker };
    // Split character chunks at inline dialogue/attribution boundaries so that
    // quoted speech and unquoted attribution are voiced by the correct speaker.
    for (const sub of splitDialogueFromAttribution(baseChunk)) {
      result.push(sub);
    }
  }
  return result;
}

/**
 * Split a single chunk at inline dialogue/attribution boundaries.
 *
 * When an AI-generated paragraph mixes a character's quoted dialogue with a
 * narrative attribution in the same sentence (e.g. "I see," she said softly.)
 * the entire chunk would otherwise be read by the character voice, making the
 * attribution sound wrong.  This function splits such chunks so that:
 *   - quoted spans  → keep the chunk's original (character) speaker
 *   - unquoted spans → switch to narrator/neutral
 *
 * Narrator-tagged chunks are returned unchanged because narration may
 * legitimately contain quoted words without implying a speaker switch.
 *
 * Both straight double-quotes (") and curly double-quotes (" ") are recognised.
 *
 * @param {{text: string, emotion: string, speaker: string}} chunk
 * @returns {Array<{text: string, emotion: string, speaker: string}>}
 */
function splitDialogueFromAttribution(chunk) {
  if (chunk.speaker === 'narrator') return [chunk];

  // Regex that matches a straight-quoted or curly-quoted span.
  // The inner character class deliberately excludes the closing quote type
  // to keep the match tight without needing look-ahead for nested quotes.
  const QUOTE_RE = /"[^"]*"|\u201C[^\u201D]*\u201D/g;

  const parts = [];
  let lastIdx = 0;
  let match;

  while ((match = QUOTE_RE.exec(chunk.text)) !== null) {
    // Any unquoted attribution text before this quote → narrator
    const before = chunk.text.slice(lastIdx, match.index).trim();
    if (before) {
      parts.push({ text: before, emotion: 'neutral', speaker: 'narrator' });
    }
    // The quoted dialogue itself → keep the character voice and emotion
    parts.push({ text: match[0], emotion: chunk.emotion, speaker: chunk.speaker });
    lastIdx = match.index + match[0].length;
  }

  // Any trailing attribution text after the last closing quote → narrator
  const trailing = chunk.text.slice(lastIdx).trim();
  if (trailing) {
    parts.push({ text: trailing, emotion: 'neutral', speaker: 'narrator' });
  }

  // If no split was made (no quotes found) return the chunk unchanged.
  return parts.length > 0 ? parts : [chunk];
}


/**
 * Ensure that the WAV audio for *text* with the given voice settings is present
 * in the disk cache.  Returns the cached Buffer (from disk or freshly
 * synthesized) and whether it was a cache hit.
 *
 * Throws an Error (with message starting "TTS service error:") on Zonos
 * failures, or re-throws native network errors so the caller can apply
 * ttsFetchError() to them.
 *
 * @param {string} text - Already-trimmed text.
 * @param {string} voiceId
 * @param {number|undefined} speakingRate
 * @param {number|undefined} pitchStd
 * @param {string} emotionPreset
 * @returns {Promise<{buf: Buffer, hit: boolean}>}
 */
async function _ensureAudioCached(text, voiceId, speakingRate, pitchStd, emotionPreset) {
  const cacheKey = ttsCacheKey(text, voiceId, speakingRate, pitchStd, emotionPreset);
  const cachePath = path.join(TTS_CACHE_DIR, `${cacheKey}.wav`);

  if (fs.existsSync(cachePath)) {
    return { buf: fs.readFileSync(cachePath), hit: true };
  }

  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  const zonosBody = { text };
  if (voiceId) zonosBody.voice_id = voiceId;
  if (typeof speakingRate === 'number') zonosBody.speaking_rate = speakingRate;
  if (typeof pitchStd === 'number') zonosBody.pitch_std = pitchStd;
  if (emotionPreset) zonosBody.emotion_preset = emotionPreset;

  const response = await fetch(`${zonosUrl}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(zonosBody),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new Error(`TTS service error: ${detail}`);
  }

  const audioBuffer = await response.arrayBuffer();
  const buf = Buffer.from(audioBuffer);
  try {
    fs.writeFileSync(cachePath, buf);
  } catch (writeErr) {
    console.warn('[TTS cache] Failed to write cache file:', writeErr.message);
  }
  return { buf, hit: false };
}

app.post('/tts', async (req, res) => {
  const { text, voice_id, speaking_rate, pitch_std, emotion_preset } = req.body;
  const err = validateStringField(text, 'text');
  if (err) return res.status(400).json({ error: err });

  const trimmed = text.trim().slice(0, TTS_MAX_CHARS);
  const voiceId = typeof voice_id === 'string' ? voice_id.trim() : '';
  const emotionPreset = typeof emotion_preset === 'string' ? emotion_preset.trim() : '';

  try {
    const { buf, hit } = await _ensureAudioCached(trimmed, voiceId, speaking_rate, pitch_std, emotionPreset);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(buf.length));
    res.set('X-TTS-Cache', hit ? 'hit' : 'miss');
    return res.send(buf);
  } catch (e) {
    if (e.message.startsWith('TTS service error:')) {
      return res.status(502).json({ error: e.message });
    }
    return res.status(502).json({ error: ttsFetchError(e) });
  }
});

/**
 * POST /tts/cached
 * Same body as POST /tts but only serves from the on-disk cache.
 * Returns the cached WAV (200) if the audio has already been synthesised,
 * or 204 No Content if it is not yet cached (without calling Zonos).
 * Used by the frontend to play pre-generated audio chunks immediately
 * while an ongoing prebake job is still generating the remaining chunks.
 */
app.post('/tts/cached', (req, res) => {
  const { text, voice_id, speaking_rate, pitch_std, emotion_preset } = req.body;
  const err = validateStringField(text, 'text');
  if (err) return res.status(400).json({ error: err });

  const trimmed = text.trim().slice(0, TTS_MAX_CHARS);
  const voiceId = typeof voice_id === 'string' ? voice_id.trim() : '';
  const emotionPreset = typeof emotion_preset === 'string' ? emotion_preset.trim() : '';

  const cacheKey = ttsCacheKey(trimmed, voiceId, speaking_rate, pitch_std, emotionPreset);
  const cachePath = path.join(TTS_CACHE_DIR, `${cacheKey}.wav`);

  if (!fs.existsSync(cachePath)) {
    return res.status(204).end();
  }

  try {
    const buf = fs.readFileSync(cachePath);
    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(buf.length));
    res.set('X-TTS-Cache', 'hit');
    return res.send(buf);
  } catch {
    return res.status(204).end();
  }
});

// ── TTS prebake job system ────────────────────────────────────────────────────
// Jobs live in memory (cleared on restart) but the WAV files they produce are
// persisted in TTS_CACHE_DIR, so reloaded stories still get cache hits.

/**
 * Poll the Zonos /health endpoint until it responds with HTTP 200 or
 * ZONOS_STARTUP_TIMEOUT_MS elapses.  Returns silently in either case so the
 * caller can proceed (individual synthesis calls will still fail gracefully if
 * Zonos is genuinely unavailable, but the common startup-race case is handled).
 *
 * Prevents a flood of "chunk failed: fetch failed" log messages when pincerx
 * starts before the Zonos model has finished loading.
 */
async function _waitForZonos() {
  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  const deadline = Date.now() + ZONOS_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${zonosUrl}/health`, { signal: AbortSignal.timeout(5_000) });
      if (resp.ok) return;
    } catch {
      // Not ready yet; fall through to sleep.
    }
    await new Promise((resolve) => setTimeout(resolve, ZONOS_STARTUP_POLL_MS).unref());
  }
}

/** @type {Map<string, {total: number, done: number, errors: number, status: string}>} */
const _prebakeJobs = new Map();

/**
 * Start a background job that synthesizes every chunk of *chapterText* and
 * writes each result to the TTS cache.  Already-cached chunks are counted as
 * done immediately.  Chunks are processed sequentially to avoid overloading
 * the Zonos sidecar.
 *
 * Emotion tags embedded in *chapterText* (e.g. "[emotion:happy]") are used
 * to select the TTS emotion on a per-chunk basis.  *emotionPreset* acts as
 * the fallback when no tag is present (e.g. for legacy content without tags).
 *
 * When *characterVoiceMap* is provided, named character speakers (e.g.
 * [speaker:Elena]) are synthesized using that character's specific Zonos
 * voice_id rather than the shared narrator *voiceId*.  The narrator voice
 * (and the legacy [speaker:male] / [speaker:female] tags) always use
 * *voiceId* as the fallback.
 *
 * @param {string} chapterText
 * @param {string} voiceId - Default (narrator) voice ID.
 * @param {number|undefined} speakingRate
 * @param {number|undefined} pitchStd
 * @param {string} emotionPreset - Fallback emotion preset.
 * @param {string} storyId
 * @param {object} [characterVoiceMap] - Map of character name → Zonos voice_id.
 * @returns {string} jobId – pass to GET /tts-prebake/:jobId to poll progress.
 */
function startPrebakeJob(chapterText, voiceId, speakingRate, pitchStd, emotionPreset, storyId, characterVoiceMap = {}) {
  const jobId = crypto.randomUUID();
  const chunks = splitIntoTTSChunksWithEmotion(chapterText, emotionPreset || 'neutral');
  const job = { total: chunks.length, done: 0, errors: 0, status: 'running' };
  _prebakeJobs.set(jobId, job);

  (async () => {
    // Wait for the Zonos sidecar to be reachable before processing chunks.
    // This avoids flooding the log with "chunk failed: fetch failed" messages
    // when pincerx starts before the Zonos model has finished loading.
    await _waitForZonos();

    const generatedKeys = [];
    for (const chunk of chunks) {
      if (job.status === 'cancelled') break;

      // Resolve the effective voice for this chunk.  Named character speakers
      // use their profile voice when available; narrator and generic male/female
      // tags fall back to the caller-supplied voiceId.
      const isGenericSpeaker = GENERIC_SPEAKERS.has(chunk.speaker);
      const effectiveVoiceId = (!isGenericSpeaker && characterVoiceMap[chunk.speaker])
        ? characterVoiceMap[chunk.speaker]
        : voiceId;

      const cacheKey = ttsCacheKey(chunk.text, effectiveVoiceId, speakingRate, pitchStd, chunk.emotion);
      try {
        await _ensureAudioCached(chunk.text, effectiveVoiceId, speakingRate, pitchStd, chunk.emotion);
        generatedKeys.push(cacheKey);
      } catch (e) {
        job.errors++;
        console.warn(`[TTS prebake ${jobId}] chunk failed:`, e.message);
      }
      job.done++;
    }
    job.status = 'complete';

    // Persist cache keys for this story so they can be removed when the story is deleted.
    if (storyId && STORY_ID_RE.test(storyId) && generatedKeys.length > 0) {
      try {
        const keysPath = path.join(TTS_CACHE_DIR, `${storyId}.cachekeys`);
        await fs.promises.appendFile(keysPath, generatedKeys.join('\n') + '\n', 'utf8');
      } catch (e) {
        console.warn('[TTS prebake] Failed to write cache keys:', e.message);
      }
    }

    // Evict the job from memory after a while so the Map doesn't grow forever.
    // .unref() ensures this timer does not keep the process alive during testing.
    setTimeout(() => _prebakeJobs.delete(jobId), PREBAKE_JOB_RETENTION_MS).unref();
  })();

  return jobId;
}

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
 * GET /tts/voice-presets
 * Returns the built-in voice presets (with labels and ready status) from the
 * Zonos sidecar.  These presets are auto-generated at sidecar startup and can
 * be assigned to characters without uploading any audio samples.
 */
app.get('/tts/voice-presets', async (_req, res) => {
  const zonosUrl = process.env.ZONOS_URL || 'http://localhost:8000';
  try {
    const response = await fetch(`${zonosUrl}/voices/presets`, { signal: AbortSignal.timeout(8000) });
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
 * Slugify a string for use as a doc ID fragment.
 * Lowercases, replaces non-alphanumeric characters with dashes, and trims
 * leading/trailing dashes.
 *
 * @param {string} str - Input string, e.g. 'Shadowfall City'.
 * @returns {string} Slug, e.g. 'shadowfall-city'.
 * @throws {Error} When the input produces an empty slug (e.g. whitespace-only input).
 * @example slugify('Shadowfall City') // → 'shadowfall-city'
 */
function slugify(str) {
  const slug = str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) {
    throw new Error('Input produces an empty slug — please provide a non-empty name.');
  }
  return slug;
}

// ── Story character profiles ──────────────────────────────────────────────────

/**
 * POST /story/:id/character
 * Body: { "name": "Elena", "role": "protagonist", "gender": "female",
 *         "personality": "...", "backstory": "...", "speechStyle": "...",
 *         "voiceId": "elena_voice" }
 * Creates or replaces a character profile in the story's RAG store.
 * The character is identified by the slugified form of their name.
 */
app.post('/story/:id/character', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }

  const { name, role, gender, personality, backstory, speechStyle, voiceId } = req.body;

  const nameErr = validateStringField(name, 'name');
  if (nameErr) return res.status(400).json({ error: nameErr });

  if (voiceId !== undefined && voiceId !== '' && !/^[A-Za-z0-9_-]+$/.test(voiceId)) {
    return res.status(400).json({ error: 'voiceId must be alphanumeric with underscores or dashes, or omitted.' });
  }

  try {
    // Verify story exists.
    story.get(id);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const slug = slugify(name.trim());
  const charId = `char-${slug}`;

  // Build a flattened content string for keyword retrieval.
  const contentParts = [
    `Name: ${name.trim()}`,
    role ? `Role: ${role}` : '',
    gender ? `Gender: ${gender}` : '',
    personality ? `Personality: ${personality}` : '',
    backstory ? `Backstory: ${backstory}` : '',
    speechStyle ? `Speech style: ${speechStyle}` : '',
  ].filter(Boolean);

  const doc = {
    id: charId,
    type: 'character',
    name: name.trim(),
    role: role || '',
    gender: gender || '',
    personality: personality || '',
    backstory: backstory || '',
    speechStyle: speechStyle || '',
    voiceId: voiceId || '',
    content: contentParts.join('. '),
  };

  try {
    storyRag.addDoc(id, doc);
    return res.status(201).json(doc);
  } catch (e) {
    return res.status(500).json({ error: `Failed to save character: ${e.message}` });
  }
});

/**
 * GET /story/:id/characters
 * Returns all character profiles stored in the story's RAG store.
 */
app.get('/story/:id/characters', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  try {
    story.get(id); // verify story exists
    const characters = storyRag.listDocs(id, 'character');
    return res.json({ characters });
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to list characters: ${e.message}` });
  }
});

/**
 * DELETE /story/:id/character/:charId
 * Removes a character profile from the story's RAG store.
 * charId is the slugified character identifier (e.g. "char-elena").
 */
app.delete('/story/:id/character/:charId', (req, res) => {
  const { id, charId } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  if (!charId || !/^char-[a-z0-9-]+$/.test(charId)) {
    return res.status(400).json({ error: 'Invalid character ID format.' });
  }
  try {
    story.get(id); // verify story exists
    const removed = storyRag.removeDoc(id, charId);
    if (!removed) {
      return res.status(404).json({ error: `Character not found: ${charId}` });
    }
    return res.json({ charId });
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to delete character: ${e.message}` });
  }
});

// ── Story lore / world-building ───────────────────────────────────────────────

/**
 * POST /story/:id/lore
 * Body: { "title": "Shadowfall City", "content": "A crumbling metropolis..." }
 * Creates or replaces a lore entry in the story's RAG store.
 * The entry is identified by the slugified form of its title.
 */
app.post('/story/:id/lore', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }

  const { title, content } = req.body;

  const titleErr = validateStringField(title, 'title');
  if (titleErr) return res.status(400).json({ error: titleErr });

  const contentErr = validateStringField(content, 'content');
  if (contentErr) return res.status(400).json({ error: contentErr });

  try {
    story.get(id); // verify story exists
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const slug = slugify(title.trim());
  const loreId = `lore-${slug}`;

  const doc = {
    id: loreId,
    type: 'lore',
    title: title.trim(),
    content: content.trim(),
  };

  try {
    storyRag.addDoc(id, doc);
    return res.status(201).json(doc);
  } catch (e) {
    return res.status(500).json({ error: `Failed to save lore entry: ${e.message}` });
  }
});

/**
 * GET /story/:id/lore
 * Returns all lore entries stored in the story's RAG store.
 */
app.get('/story/:id/lore', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  try {
    story.get(id); // verify story exists
    const loreEntries = storyRag.listDocs(id, 'lore');
    return res.json({ lore: loreEntries });
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to list lore entries: ${e.message}` });
  }
});

/**
 * DELETE /story/:id/lore/:loreId
 * Removes a lore entry from the story's RAG store.
 * loreId is the slugified lore identifier (e.g. "lore-shadowfall-city").
 */
app.delete('/story/:id/lore/:loreId', (req, res) => {
  const { id, loreId } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  if (!loreId || !/^lore-[a-z0-9-]+$/.test(loreId)) {
    return res.status(400).json({ error: 'Invalid lore ID format.' });
  }
  try {
    story.get(id); // verify story exists
    const removed = storyRag.removeDoc(id, loreId);
    if (!removed) {
      return res.status(404).json({ error: `Lore entry not found: ${loreId}` });
    }
    return res.json({ loreId });
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to delete lore entry: ${e.message}` });
  }
});

/**
 * GET /story/:id/character-voices
 * Returns a map of character name → Zonos voice_id for characters that have a
 * voice profile assigned.  The frontend can use this to resolve the correct
 * voice_id when calling /tts for a named character speaker.
 */
app.get('/story/:id/character-voices', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  try {
    story.get(id); // verify story exists
    const characters = storyRag.listDocs(id, 'character');
    const voiceMap = {};
    for (const c of characters) {
      if (c.name && c.voiceId) {
        voiceMap[c.name] = c.voiceId;
      }
    }
    return res.json({ voices: voiceMap });
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to load character voices: ${e.message}` });
  }
});

/**
 * GET /story/list
 * Returns summary metadata for all saved stories, newest first.
 */
app.get('/story/list', (_req, res) => {
  try {
    return res.json({ stories: story.list() });
  } catch (e) {
    return res.status(500).json({ error: `Failed to list stories: ${e.message}` });
  }
});

/**
 * GET /story/:id
 * Returns the full story data including all generated chapters.
 */
app.get('/story/:id', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  try {
    return res.json(story.get(id));
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Failed to load story: ${e.message}` });
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
 * Body: { "chapterNumber": 1, "customPrompt": "...", "dialogRatio": 60 }
 * Generates a chapter for an existing story and saves it to data/stories/.
 * dialogRatio (0–100) controls the percentage of character dialogue vs narration.
 */
app.post('/story/:id/chapter', async (req, res) => {
  const { id } = req.params;
  const { chapterNumber, customPrompt, dialogRatio } = req.body;

  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }

  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    return res.status(400).json({ error: 'Request body must include a positive integer "chapterNumber".' });
  }

  const prompt = typeof customPrompt === 'string' ? customPrompt.trim() : '';
  const aiOptions = {};
  if (typeof dialogRatio === 'number' && Number.isFinite(dialogRatio)) {
    aiOptions.dialogRatio = dialogRatio;
  }

  try {
    const result = await story.generateChapter(id, chapterNumber, aiOptions, prompt);
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

  if (!id || !STORY_ID_RE.test(id)) {
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

/**
 * PATCH /story/:id/chapter/:num
 * Body: { "content": "updated chapter text with [speaker:X][emotion:X] tags" }
 * Replaces the content of a specific chapter in-place on disk.
 * Used by the Voice Transcript editor to save per-paragraph speaker/emotion changes.
 */
app.patch('/story/:id/chapter/:num', (req, res) => {
  const { id, num } = req.params;
  const chapterNumber = parseInt(num, 10);

  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    return res.status(400).json({ error: 'Invalid chapter number.' });
  }

  const { content } = req.body;
  const contentErr = validateStringField(content, 'content');
  if (contentErr) return res.status(400).json({ error: contentErr });

  try {
    const result = story.updateChapterContent(id, chapterNumber, content.trim());
    return res.json(result);
  } catch (e) {
    if (e.message.startsWith('Story not found') || e.message.startsWith('Chapter')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Update chapter error: ${e.message}` });
  }
});

/**
 * DELETE /story/:id
 * Permanently deletes an entire story and all its chapters from disk.
 * Also removes any TTS cache audio files that were pre-generated for this story.
 */
app.delete('/story/:id', (req, res) => {
  const { id } = req.params;
  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  try {
    // Remove TTS cache audio files recorded for this story during prebaking.
    // id is validated above via STORY_ID_RE, so it is safe to use in a path.
    const keysPath = path.join(TTS_CACHE_DIR, `${id}.cachekeys`);
    if (fs.existsSync(keysPath)) {
      const keys = fs.readFileSync(keysPath, 'utf8').split('\n').filter(Boolean);
      // SHA256_RE ensures each key is a safe 64-char hex digest before path use.
      for (const key of keys) {
        if (!SHA256_RE.test(key)) continue;
        const wavPath = path.join(TTS_CACHE_DIR, `${key}.wav`);
        try { if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(keysPath); } catch { /* ignore */ }
    }

    const result = story.deleteStory(id);
    return res.json(result);
  } catch (e) {
    if (e.message.startsWith('Story not found')) {
      return res.status(404).json({ error: e.message });
    }
    return res.status(500).json({ error: `Delete story error: ${e.message}` });
  }
});

/**
 * POST /story/:id/chapter/:num/tts-prebake
 * Body: { "voice_id": "", "speaking_rate": 15, "pitch_std": 45, "emotion_preset": "neutral" }
 * Starts a background job that synthesizes every sentence chunk of the chapter
 * and writes each WAV to the TTS cache.  Already-cached chunks are skipped.
 * Returns { jobId, total } immediately; poll GET /tts-prebake/:jobId for progress.
 */
app.post('/story/:id/chapter/:num/tts-prebake', (req, res) => {
  const { id, num } = req.params;
  const chapterNum = parseInt(num, 10);

  if (!id || !STORY_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Invalid story ID format.' });
  }
  if (!Number.isInteger(chapterNum) || chapterNum < 1) {
    return res.status(400).json({ error: 'Invalid chapter number.' });
  }

  let storyData;
  try {
    storyData = story.get(id);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const chapter = (storyData.chapters || []).find((c) => c.number === chapterNum);
  if (!chapter) {
    return res.status(404).json({ error: `Chapter ${chapterNum} not found in story ${id}.` });
  }

  const { voice_id, speaking_rate, pitch_std, emotion_preset } = req.body;
  const voiceId = typeof voice_id === 'string' ? voice_id.trim() : '';
  const emotionPreset = typeof emotion_preset === 'string' ? emotion_preset.trim() : '';

  // Build a character name → Zonos voice_id map from the story's RAG profiles
  // so that named character speakers are synthesized with their assigned voice.
  const charDocs = storyRag.listDocs(id, 'character');
  const characterVoiceMap = {};
  for (const c of charDocs) {
    if (c.name && c.voiceId) {
      characterVoiceMap[c.name] = c.voiceId;
    }
  }

  const jobId = startPrebakeJob(chapter.content, voiceId, speaking_rate, pitch_std, emotionPreset, id, characterVoiceMap);
  return res.json({ jobId, total: _prebakeJobs.get(jobId).total });
});

/**
 * GET /tts-prebake/:jobId
 * Poll the progress of a TTS prebake job.
 * Returns { total, done, errors, status } where status is 'running' | 'complete'.
 */
app.get('/tts-prebake/:jobId', (req, res) => {
  const job = _prebakeJobs.get(req.params.jobId);
  if (!job) {
    // Job not found – either completed and evicted, or invalid.  Return a
    // synthetic "complete" so the client stops polling.
    return res.json({ total: 0, done: 0, errors: 0, status: 'complete' });
  }
  return res.json({ total: job.total, done: job.done, errors: job.errors, status: job.status });
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

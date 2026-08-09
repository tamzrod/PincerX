'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// When PincerX runs inside Docker, "localhost" refers to the container itself,
// not the host where Ollama typically runs. host.docker.internal resolves to
// the Docker host, so it is the correct default for a containerized PincerX
// talking to a host-side Ollama. Override with AI_BASE_URL if needed.
const DEFAULT_BASE_URL = process.env.AI_BASE_URL || 'http://host.docker.internal:11434';
const DEFAULT_MODEL = process.env.AI_MODEL || 'llama3';
const DEFAULT_API_KEY = process.env.AI_API_KEY || '';
const DEFAULT_TIMEOUT_MS = process.env.AI_TIMEOUT_MS ? parseInt(process.env.AI_TIMEOUT_MS, 10) : 120000;

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');

/**
 * Normalize and validate an AI base URL.
 *
 * - Ensures the URL starts with "http://" or "https://".
 * - Removes trailing slashes.
 * - Rejects bare protocol names (e.g. "http"), empty strings, and other
 *   values that cannot form a valid URL.
 *
 * @param {string} url - Raw base URL string to normalize.
 * @returns {string} Normalized URL.
 * @throws {Error} When the value cannot be made into a valid URL.
 */
function normalizeBaseUrl(url) {
  if (!url || typeof url !== 'string' || url.trim() === '') {
    throw new Error('Invalid AI_BASE_URL configuration');
  }

  let normalized = url.trim();

  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    // Valid protocol prefix — check for accidental double-protocol such as
    // "http://http://..." which produces a nonsensical hostname.
    const withoutProtocol = normalized.replace(/^https?:\/\//, '');
    if (/^https?:\/\//i.test(withoutProtocol)) {
      throw new Error('Invalid AI_BASE_URL configuration');
    }
  } else if (/^https?/i.test(normalized)) {
    // Starts with "http" or "https" but without "://" — malformed protocol.
    throw new Error('Invalid AI_BASE_URL configuration');
  } else {
    // No protocol present; assume http://.
    normalized = 'http://' + normalized;
  }

  // Remove trailing slashes.
  normalized = normalized.replace(/\/+$/, '');

  // Final structural validation via the WHATWG URL parser.
  try {
    new URL(normalized); // eslint-disable-line no-new
  } catch {
    throw new Error('Invalid AI_BASE_URL configuration');
  }

  return normalized;
}

// Log the resolved base URL at module load so misconfiguration is visible
// immediately on startup.
try {
  console.log('[AI] Using base URL:', normalizeBaseUrl(DEFAULT_BASE_URL));
} catch (e) {
  console.error('[AI] Warning: AI_BASE_URL is invalid:', e.message);
}

/**
 * Load runtime AI config from data/ai-config.json.
 * Returns an empty object if the file is missing or unreadable.
 *
 * @returns {{ baseUrl?: string, model?: string, apiKey?: string }}
 */
function loadRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Build a low-level http/https request and return the full response body.
 *
 * @param {string} method - HTTP method (e.g. "GET", "POST").
 * @param {string} baseUrl - Normalized base URL (may include a path prefix such as /openai/v1).
 * @param {string} endpointPath - Relative path to append (e.g. "api/tags", "chat/completions").
 * @param {string|null} [body] - Optional request body to send.
 * @param {object} [extraHeaders] - Additional headers.
 * @returns {Promise<string>} Raw response body.
 */
function httpRequest(method, baseUrl, endpointPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    // Ensure the base URL ends with "/" so that relative endpoint paths
    // are resolved correctly even when the base includes a path prefix
    // (e.g. https://api.groq.com/openai/v1/chat/completions).
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = new URL(endpointPath, base);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = { ...extraHeaders };
    if (body !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', reject);

    if (body !== null) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * List available model names from an Ollama-compatible or OpenAI-compatible backend.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl]  - Base URL of the AI API.
 * @param {string} [options.provider] - API format: "ollama" (default), "openai", "groq", or "openrouter".
 *   "groq" and "openrouter" both use the OpenAI-compatible API format.
 * @param {string} [options.apiKey]   - Bearer token sent when using the OpenAI format.
 * @returns {Promise<string[]>} Array of model name strings.
 */
async function listModels(options = {}) {
  const runtimeConfig = loadRuntimeConfig();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || runtimeConfig.baseUrl || DEFAULT_BASE_URL
  );
  const provider = options.provider || runtimeConfig.provider || 'ollama';
  const apiKey = options.apiKey || runtimeConfig.apiKey || DEFAULT_API_KEY;

  // groq and openrouter both speak the OpenAI-compatible API.
  const isOpenAI = provider === 'openai' || provider === 'groq' || provider === 'openrouter';

  let raw;
  try {
    if (isOpenAI) {
      const extraHeaders = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      raw = await httpRequest('GET', baseUrl, 'models', null, extraHeaders);
    } else {
      raw = await httpRequest('GET', baseUrl, 'api/tags');
    }
  } catch (err) {
    throw new Error(`Failed to list models: ${err.message}`);
  }

  try {
    const parsed = JSON.parse(raw);
    if (isOpenAI) {
      return (parsed.data || [])
        .map((m) => (typeof m === 'string' ? m : m.id))
        .filter((id) => typeof id === 'string' && id.length > 0);
    }
    return (parsed.models || []).map((m) => m.name).filter((name) => typeof name === 'string' && name.length > 0);
  } catch (err) {
    throw new Error(`Failed to parse model list: ${err.message}`);
  }
}

/**
 * Send a prompt to an Ollama-compatible or OpenAI-compatible AI backend and return the response text.
 *
 * Provider "ollama" (default): uses POST api/generate with { model, prompt, stream }.
 * Provider "openai", "groq", or "openrouter": uses POST chat/completions with { model, messages, stream }
 *   — compatible with Groq, OpenRouter, and any other OpenAI-API provider.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} [options]
 * @param {string} [options.baseUrl]    - Base URL of the AI API (defaults to AI_BASE_URL env var or http://host.docker.internal:11434).
 * @param {string} [options.model]      - Model name to use (defaults to AI_MODEL env var or llama3).
 * @param {string} [options.apiKey]     - API key sent as Bearer token (defaults to AI_API_KEY env var).
 * @param {string} [options.provider]   - API format: "ollama" (default), "openai", "groq", or "openrouter".
 * @param {number} [options.timeoutMs]  - Request timeout in milliseconds (default: 30 000).
 * @returns {Promise<string>} The AI response text.
 */
function ask(prompt, options = {}) {
  const runtimeConfig = loadRuntimeConfig();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || runtimeConfig.baseUrl || DEFAULT_BASE_URL
  );
  const model = options.model || runtimeConfig.model || DEFAULT_MODEL;
  const apiKey = options.apiKey || runtimeConfig.apiKey || DEFAULT_API_KEY;
  const provider = options.provider || runtimeConfig.provider || 'ollama';
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  // groq and openrouter both speak the OpenAI-compatible chat/completions API.
  const isOpenAI = provider === 'openai' || provider === 'groq' || provider === 'openrouter';
  const endpointPath = isOpenAI ? 'chat/completions' : 'api/generate';
  const bodyObj = isOpenAI
    ? { model, messages: [{ role: 'user', content: prompt }], stream: false }
    : { model, prompt, stream: false };

  // Forward a generation token budget when the caller requests one. This keeps
  // the model from being cut off short of a requested output length (e.g. long
  // story chapters). OpenAI-compatible APIs use "max_tokens"; Ollama uses
  // "num_predict". A positive integer is honoured; anything else is ignored.
  const tokenBudget = (typeof options.maxTokens === 'number' && options.maxTokens > 0)
    ? Math.round(options.maxTokens)
    : null;
  if (tokenBudget) {
    if (isOpenAI) {
      bodyObj.max_tokens = tokenBudget;
    } else {
      bodyObj.num_predict = tokenBudget;
    }
  }

  const body = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    // Ensure base ends with "/" so relative endpoint path is appended correctly
    // even when the base URL includes a path prefix (e.g. /openai/v1).
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = new URL(endpointPath, base);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    };

    // Settled flag + helper prevent double-resolve/reject and ensure the timer
    // is always cleared regardless of which path (success / error / timeout) wins.
    let settled = false;
    let timer;

    function settle(fn) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    }

    const req = transport.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        settle(() => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              // Extract a readable string from the error value regardless of its type.
              const raw = parsed.error;
              let msg;
              if (typeof raw === 'string') {
                msg = raw;
              } else if (raw !== null && typeof raw === 'object' && typeof raw.message === 'string') {
                msg = raw.message;
              } else {
                msg = JSON.stringify(raw);
              }
              return reject(new Error(`AI error: ${msg}`));
            }
            if (isOpenAI) {
              resolve(parsed.choices?.[0]?.message?.content || '');
            } else {
              resolve(parsed.response || '');
            }
          } catch (err) {
            reject(new Error(`Failed to parse AI response: ${err.message}`));
          }
        });
      });
    });

    req.on('error', (err) => {
      settle(() => reject(new Error(`AI request failed (${baseUrl}, model=${model}): ${err.message}`)));
    });

    // Destroy the request on timeout only if the promise is not yet settled.
    // Guarding with `settled` here prevents req.destroy() from being called
    // after a successful response.  clearTimeout() inside settle() prevents
    // any leak when the response arrives before the deadline.
    timer = setTimeout(() => {
      if (!settled) {
        req.destroy(new Error('AI request timed out'));
      }
    }, timeoutMs);

    req.write(body);
    req.end();
  });
}

/**
 * Streaming variant of ask(). Sends the same request but with stream:true and
 * invokes onToken(chunkText, { done }) for each generated token chunk as it
 * arrives. Resolves with the full accumulated text once the stream completes.
 *
 * Ollama streams newline-delimited JSON objects (each with a `response` field
 * holding a token fragment; the final object has `done:true`). OpenAI/Groq/
 * OpenRouter stream Server-Sent Events: lines starting with "data: " carrying
 * a JSON object with `choices[0].delta.content`, terminated by "data: [DONE]".
 *
 * Falls back gracefully: if a backend ignores stream:true and returns a single
 * buffered JSON object, the whole payload is parsed and emitted as one token
 * (so callers still get the text).
 *
 * @param {string} prompt
 * @param {object} [options] - Same options as ask() (baseUrl, model, provider,
 *   apiKey, timeoutMs, maxTokens).
 * @param {(chunk: string, meta: { done: boolean }) => void} [onToken] - Called
 *   for each token fragment as it arrives.
 * @returns {Promise<string>} The full response text.
 */
// Classification of transport failures that may occur AFTER partial streaming
// output has been received. On such a failure the caller can preserve the
// already-accumulated text (attached as `err.partial`) and offer a resume
// rather than discarding the work.
function classifyStreamError(message) {
  if (/timed out/i.test(message)) return 'timeout';
  if (/ECONN|EPIPE|ECONNRESET|ECONNREFUSED|socket hang up|network|aborted/i.test(message)) return 'connection';
  return 'transport';
}

// Minimum accumulated text length (in characters) for a partial stream result
// to be considered "meaningful content" worth preserving for a resume. Below
// this threshold a timeout is treated as if no usable output was received.
const MIN_PARTIAL_CHARS = 40;

/**
 * Returns true when an accumulated stream string contains enough real content
 * to preserve as a partial chapter (used by the resume feature).
 */
function isMeaningfulPartial(text) {
  return typeof text === 'string' && text.trim().length >= MIN_PARTIAL_CHARS;
}

function askStream(prompt, options = {}, onToken) {
  const runtimeConfig = loadRuntimeConfig();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || runtimeConfig.baseUrl || DEFAULT_BASE_URL
  );
  const model = options.model || runtimeConfig.model || DEFAULT_MODEL;
  const apiKey = options.apiKey || runtimeConfig.apiKey || DEFAULT_API_KEY;
  const provider = options.provider || runtimeConfig.provider || 'ollama';
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const isOpenAI = provider === 'openai' || provider === 'groq' || provider === 'openrouter';
  const endpointPath = isOpenAI ? 'chat/completions' : 'api/generate';
  const bodyObj = isOpenAI
    ? { model, messages: [{ role: 'user', content: prompt }], stream: true }
    : { model, prompt, stream: true };

  const tokenBudget = (typeof options.maxTokens === 'number' && options.maxTokens > 0)
    ? Math.round(options.maxTokens)
    : null;
  if (tokenBudget) {
    if (isOpenAI) bodyObj.max_tokens = tokenBudget;
    else bodyObj.num_predict = tokenBudget;
  }

  const body = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
    const url = new URL(endpointPath, base);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    // Ollama streams NDJSON; OpenAI-compatible APIs stream SSE.
    if (isOpenAI) headers['Accept'] = 'text/event-stream';
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    };

    let settled = false;
    let timer;
    function settle(fn) {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn();
      }
    }

    let fullText = '';
    // Buffer for partial lines (streaming responses may split a line across chunks).
    let lineBuffer = '';
    // Fallback: if the backend ignores stream:true and returns buffered JSON,
    // accumulate the whole body and parse once at the end.
    let bufferedFallback = '';

    function processLine(line) {
      if (!line) return;
      if (isOpenAI) {
        // SSE: lines look like "data: {...}" or "data: [DONE]".
        if (!line.startsWith('data:')) return;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const obj = JSON.parse(payload);
          const frag = obj.choices?.[0]?.delta?.content || '';
          if (frag) {
            fullText += frag;
            if (onToken) onToken(frag, { done: false });
          }
        } catch { /* ignore malformed SSE lines */ }
      } else {
        // Ollama NDJSON: one JSON object per line.
        try {
          const obj = JSON.parse(line);
          const frag = obj.response || '';
          if (frag) {
            fullText += frag;
            if (onToken) onToken(frag, { done: false });
          }
          // obj.done:true marks stream end; no token to emit (the caller learns
          // completion from the resolved promise / the server's `done` event).
        } catch {
          // Not valid JSON on this line — treat as buffered (non-streamed) response.
          bufferedFallback += line;
        }
      }
    }

    const req = transport.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        // Drain the (likely short) error body for a readable message.
        let errBody = '';
        res.on('data', (c) => { errBody += c; });
        res.on('end', () => {
          settle(() => {
            let msg = errBody;
            try { msg = JSON.parse(errBody).error || errBody; } catch { /* keep raw */ }
            reject(new Error(`AI error: ${msg}`));
          });
        });
        return;
      }

      res.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf8');
        let idx;
        // Split on newlines; keep any trailing partial line in the buffer.
        while ((idx = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, idx).replace(/\r$/, '');
          lineBuffer = lineBuffer.slice(idx + 1);
          processLine(line);
        }
      });

      res.on('end', () => {
        settle(() => {
          // Flush any trailing line without a newline.
          if (lineBuffer.trim()) processLine(lineBuffer);

          // Buffered-fallback path: backend returned one JSON blob instead of a stream.
          if (!fullText && bufferedFallback) {
            try {
              const parsed = JSON.parse(bufferedFallback);
              if (parsed.error) {
                return reject(new Error(`AI error: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)}`));
              }
              const text = isOpenAI
                ? (parsed.choices?.[0]?.message?.content || '')
                : (parsed.response || '');
              fullText = text;
              if (onToken && text) onToken(text, { done: false });
            } catch (err) {
              return reject(new Error(`Failed to parse AI response: ${err.message}`));
            }
          }
          resolve(fullText);
        });
      });
    });

    req.on('error', (err) => {
      settle(() => {
        const reason = classifyStreamError(err.message);
        // Preserve any text already streamed before the transport failure so
        // the caller can offer a resume instead of discarding the work. Only
        // attach the partial when it is meaningful; otherwise behave like a
        // normal failure (no resume possible).
        if (isMeaningfulPartial(fullText)) {
          const wrapped = new Error(`AI request failed (${baseUrl}, model=${model}): ${err.message}`);
          wrapped.partial = fullText;
          wrapped.reason = reason;
          reject(wrapped);
        } else {
          reject(new Error(`AI request failed (${baseUrl}, model=${model}): ${err.message}`));
        }
      });
    });

    timer = setTimeout(() => {
      if (!settled) req.destroy(new Error('AI request timed out'));
    }, timeoutMs);

    req.write(body);
    req.end();
  });
}

module.exports = { ask, askStream, listModels, normalizeBaseUrl, isMeaningfulPartial, classifyStreamError, MIN_PARTIAL_CHARS };

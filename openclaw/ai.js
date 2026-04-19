'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const DEFAULT_BASE_URL = process.env.AI_BASE_URL || 'http://localhost:11434';
const DEFAULT_MODEL = process.env.AI_MODEL || 'llama3';
const DEFAULT_API_KEY = process.env.AI_API_KEY || '';
const DEFAULT_TIMEOUT_MS = 30000;

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
 * @param {string} baseUrl - Normalized base URL.
 * @param {string} endpointPath - Path to append (e.g. "/api/tags").
 * @param {string|null} [body] - Optional request body to send.
 * @param {object} [extraHeaders] - Additional headers.
 * @returns {Promise<string>} Raw response body.
 */
function httpRequest(method, baseUrl, endpointPath, body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpointPath, baseUrl);
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
 * List available model names from an Ollama-compatible backend.
 *
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Base URL of the AI API.
 * @returns {Promise<string[]>} Array of model name strings.
 */
async function listModels(options = {}) {
  const runtimeConfig = loadRuntimeConfig();
  const baseUrl = normalizeBaseUrl(
    options.baseUrl || runtimeConfig.baseUrl || DEFAULT_BASE_URL
  );

  let raw;
  try {
    raw = await httpRequest('GET', baseUrl, '/api/tags');
  } catch (err) {
    throw new Error(`Failed to list models: ${err.message}`);
  }

  try {
    const parsed = JSON.parse(raw);
    return (parsed.models || []).map((m) => m.name).filter((name) => typeof name === 'string' && name.length > 0);
  } catch (err) {
    throw new Error(`Failed to parse model list: ${err.message}`);
  }
}

/**
 * Send a prompt to an Ollama-compatible AI backend and return the response text.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} [options]
 * @param {string} [options.baseUrl]    - Base URL of the AI API (defaults to AI_BASE_URL env var or http://localhost:11434).
 * @param {string} [options.model]      - Model name to use (defaults to AI_MODEL env var or llama3).
 * @param {string} [options.apiKey]     - API key sent as Bearer token (defaults to AI_API_KEY env var).
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
  const timeoutMs = options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/api/generate', baseUrl);
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
              return reject(new Error(`AI error: ${parsed.error}`));
            }
            resolve(parsed.response || '');
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

module.exports = { ask, listModels, normalizeBaseUrl };

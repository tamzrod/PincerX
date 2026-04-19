'use strict';

const http = require('http');

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Send a prompt to an Ollama-compatible AI backend and return the response text.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} [options]
 * @param {string} [options.baseUrl]  - Base URL of the Ollama API.
 * @param {string} [options.model]    - Model name to use.
 * @param {number} [options.timeout]  - Request timeout in milliseconds (default: 10000).
 * @returns {Promise<string>} The AI response text.
 */
function ask(prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const model = options.model || DEFAULT_MODEL;
  const timeoutMs = options.timeout !== undefined ? options.timeout : DEFAULT_TIMEOUT_MS;

  const body = JSON.stringify({
    model,
    prompt,
    stream: false,
  });

  return new Promise((resolve, reject) => {
    const url = new URL('/api/generate', baseUrl);

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    let settled = false;
    let timer = null;

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let error;
        let value;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            error = new Error(`AI error: ${parsed.error}`);
          } else {
            value = parsed.response || '';
          }
        } catch (err) {
          error = new Error(`Failed to parse AI response: ${err.message}`);
        }
        if (error) {
          finish(reject, error);
        } else {
          finish(resolve, value);
        }
      });
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        req.destroy();
        finish(reject, new Error('AI request timed out'));
      }, timeoutMs);
    }

    req.on('error', (err) => finish(reject, new Error(`AI request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

module.exports = { ask };

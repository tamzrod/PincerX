'use strict';

const http = require('http');

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3';

/**
 * Send a prompt to an Ollama-compatible AI backend and return the response text.
 *
 * @param {string} prompt - The prompt to send.
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Base URL of the Ollama API.
 * @param {string} [options.model]   - Model name to use.
 * @returns {Promise<string>} The AI response text.
 */
function ask(prompt, options = {}) {
  const baseUrl = options.baseUrl || DEFAULT_BASE_URL;
  const model = options.model || DEFAULT_MODEL;

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

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
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

    req.on('error', (err) => reject(new Error(`AI request failed: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

module.exports = { ask };

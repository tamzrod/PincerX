'use strict';

const fs = require('fs');
const path = require('path');
const ai = require('../openclaw/ai');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

/**
 * Generate a story outline using AI and persist it to disk.
 *
 * @param {string} title   - The story title.
 * @param {string} genre   - The story genre (e.g. "fantasy", "thriller").
 * @param {string} tone    - The desired tone (e.g. "dark", "humorous").
 * @param {object} [aiOptions] - Options forwarded to ai.ask().
 * @returns {Promise<{id: string, title: string, genre: string, tone: string, outline: string, createdAt: string}>}
 */
async function create(title, genre, tone, aiOptions = {}) {
  const prompt = [
    'You are a creative writing assistant. Generate a structured story outline.',
    'Respond with ONLY a valid JSON object containing exactly these fields:',
    '  "outline": a detailed story outline as a single string (acts, chapters, or scenes)',
    '',
    'Do not include any explanation or text outside the JSON object.',
    '',
    `Title: ${title}`,
    `Genre: ${genre}`,
    `Tone: ${tone}`,
  ].join('\n');

  const raw = await ai.ask(prompt, aiOptions);
  const outline = parseOutline(raw);

  const id = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const createdAt = new Date().toISOString();
  const story = { id, title, genre, tone, outline, createdAt };

  fs.mkdirSync(STORIES_DIR, { recursive: true });
  const filename = path.basename(`${id}.json`);
  fs.writeFileSync(path.join(STORIES_DIR, filename), JSON.stringify(story, null, 2), 'utf8');

  return story;
}

/**
 * Extract the outline string from the AI response.
 * Falls back to the raw response text if JSON parsing fails.
 *
 * @param {string} raw - Raw string from the AI.
 * @returns {string}
 */
function parseOutline(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.outline === 'string' && parsed.outline.trim()) {
        return parsed.outline.trim();
      }
    } catch {
      // fall through to raw fallback
    }
  }
  return raw.trim();
}

module.exports = { create };

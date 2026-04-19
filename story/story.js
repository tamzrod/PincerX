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

/**
 * Generate a chapter for an existing story and persist it to disk.
 *
 * @param {string} storyId       - The story ID (from the `id` field of a saved story).
 * @param {number} chapterNumber - 1-based chapter index to generate.
 * @param {object} [aiOptions]   - Options forwarded to ai.ask().
 * @param {string} [customPrompt] - Optional extra instructions for the AI.
 * @returns {Promise<{storyId: string, chapterNumber: number, content: string}>}
 */
async function generateChapter(storyId, chapterNumber, aiOptions = {}, customPrompt = '') {
  const filename = path.basename(`${storyId}.json`);
  const filepath = path.join(STORIES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const storyData = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  const prior = (storyData.chapters || [])
    .filter((c) => c.number < chapterNumber)
    .sort((a, b) => a.number - b.number)
    .map((c) => `Chapter ${c.number}:\n${c.content}`)
    .join('\n\n');

  const prompt = [
    'You are a creative writing assistant. Write a detailed, immersive chapter of a story.',
    'Respond with ONLY a valid JSON object containing exactly this field:',
    '  "content": the full chapter text as a single well-formatted string (prose paragraphs separated by blank lines)',
    '',
    'The chapter must be substantial: at least 700 words with vivid descriptions, meaningful dialogue, and strong pacing.',
    'Do not include any explanation or text outside the JSON object.',
    '',
    `Title: ${storyData.title}`,
    `Genre: ${storyData.genre}`,
    `Tone: ${storyData.tone}`,
    `Outline:\n${storyData.outline}`,
    prior ? `\nPreviously written chapters:\n${prior}` : '',
    customPrompt ? `\nAdditional instructions: ${customPrompt}` : '',
    `\nNow write Chapter ${chapterNumber}. Make it complete, engaging, and rich in detail.`,
  ].join('\n');

  const raw = await ai.ask(prompt, aiOptions);
  const content = parseChapterContent(raw);
  const chapter = { number: chapterNumber, content, createdAt: new Date().toISOString() };

  if (!storyData.chapters) storyData.chapters = [];
  const idx = storyData.chapters.findIndex((c) => c.number === chapterNumber);
  if (idx >= 0) {
    storyData.chapters[idx] = chapter;
  } else {
    storyData.chapters.push(chapter);
    storyData.chapters.sort((a, b) => a.number - b.number);
  }

  fs.writeFileSync(filepath, JSON.stringify(storyData, null, 2), 'utf8');
  return { storyId, chapterNumber, content };
}

/**
 * Extract the chapter content string from the AI response.
 * Falls back to the raw response text if JSON parsing fails.
 *
 * @param {string} raw - Raw string from the AI.
 * @returns {string}
 */
function parseChapterContent(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return parsed.content.trim();
      }
    } catch {
      // fall through to raw fallback
    }
  }
  return raw.trim();
}

/**
 * Delete a chapter from an existing story on disk.
 *
 * @param {string} storyId       - The story ID.
 * @param {number} chapterNumber - 1-based chapter number to delete.
 * @returns {Promise<{storyId: string, chapterNumber: number}>}
 */
async function deleteChapter(storyId, chapterNumber) {
  const filename = path.basename(`${storyId}.json`);
  const filepath = path.join(STORIES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const storyData = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  if (!storyData.chapters) storyData.chapters = [];
  const idx = storyData.chapters.findIndex((c) => c.number === chapterNumber);
  if (idx < 0) {
    throw new Error(`Chapter ${chapterNumber} not found in story: ${storyId}`);
  }

  storyData.chapters.splice(idx, 1);
  fs.writeFileSync(filepath, JSON.stringify(storyData, null, 2), 'utf8');
  return { storyId, chapterNumber };
}

module.exports = { create, generateChapter, deleteChapter };

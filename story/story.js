'use strict';

const fs = require('fs');
const path = require('path');
const ai = require('../openclaw/ai');
const storyRag = require('./story-rag');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

/**
 * Generate a story outline using AI and persist it to disk.
 * Also seeds the story's RAG store with an initial cast of characters and
 * key locations extracted from the same AI response.
 *
 * @param {string} title   - The story title.
 * @param {string} genre   - The story genre (e.g. "fantasy", "thriller").
 * @param {string} tone    - The desired tone (e.g. "dark", "humorous").
 * @param {object} [aiOptions] - Options forwarded to ai.ask().
 * @returns {Promise<{id: string, title: string, genre: string, tone: string, outline: string, createdAt: string}>}
 */
async function create(title, genre, tone, aiOptions = {}) {
  const prompt = [
    'You are a creative writing assistant. Generate a structured story outline with an initial world.',
    'Respond with ONLY a valid JSON object containing exactly these fields:',
    '  "outline": a detailed story outline as a single string (acts, chapters, or scenes)',
    '  "characters": an array of initial characters, each with: "name" (string), "role" (e.g. protagonist/villain/supporting), "gender" (one of "male","female","non-binary",""), "personality" (comma-separated traits), "backstory" (1-2 sentences)',
    '  "locations": an array of key locations/settings, each with: "title" (string), "description" (1-2 sentences)',
    '',
    'Do not include any explanation or text outside the JSON object.',
    '',
    `Title: ${title}`,
    `Genre: ${genre}`,
    `Tone: ${tone}`,
  ].join('\n');

  const raw = await ai.ask(prompt, aiOptions);
  const { outline, characters, locations } = parseCreateResponse(raw);

  const id = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const createdAt = new Date().toISOString();
  const storyObj = { id, title, genre, tone, outline, createdAt };

  fs.mkdirSync(STORIES_DIR, { recursive: true });
  const filename = path.basename(`${id}.json`);
  fs.writeFileSync(path.join(STORIES_DIR, filename), JSON.stringify(storyObj, null, 2), 'utf8');

  // Seed the story RAG store with the initial cast of characters.
  for (const char of characters) {
    const voiceId = pickVoicePreset(char.gender, char.personality);
    const slug    = _slugify(char.name);
    const charId  = `char-${slug}`;

    const contentParts = [
      `Name: ${char.name}`,
      char.role        ? `Role: ${char.role}`               : '',
      char.gender      ? `Gender: ${char.gender}`           : '',
      char.personality ? `Personality: ${char.personality}` : '',
      char.backstory   ? `Backstory: ${char.backstory}`     : '',
    ].filter(Boolean);

    storyRag.addDoc(id, {
      id:          charId,
      type:        'character',
      name:        char.name,
      role:        char.role,
      gender:      char.gender,
      personality: char.personality,
      backstory:   char.backstory,
      speechStyle: '',
      voiceId,
      content:     contentParts.join('. '),
    });
  }

  // Seed the story RAG store with the initial locations as lore entries.
  for (const loc of locations) {
    const slug = _slugify(loc.title);
    storyRag.addDoc(id, {
      id:      `lore-${slug}`,
      type:    'lore',
      title:   loc.title,
      content: loc.description,
    });
  }

  return storyObj;
}

/** Minimum target word count included in the chapter generation prompt. */
const CHAPTER_MIN_WORDS = 700;

/** Generic speaker names that are never real character profiles. */
const GENERIC_SPEAKERS = new Set(['narrator', 'male', 'female']);

/**
 * Map a character's gender and optional personality description to the
 * best-fit built-in voice preset.
 *
 * Preset IDs match those auto-created by the Zonos sidecar at startup.
 *
 * @param {string} gender      - 'male', 'female', 'non-binary', or '' for unspecified.
 * @param {string} [personality] - Optional personality/description text used to
 *   detect age hints (e.g. "young", "elderly").
 * @returns {string} A preset voice ID.
 */
function pickVoicePreset(gender, personality = '') {
  const g = (gender || '').toLowerCase();
  const desc = (personality || '').toLowerCase();
  const isYoung   = /\b(young|child|teen|youth|kid)\b/.test(desc);
  const isElderly = /\b(old|elder|aged|elderly|senior)\b/.test(desc);

  if (g === 'female' || g === 'non-binary') {
    if (isYoung)   return 'preset-young-girl';
    if (isElderly) return 'preset-elderly-female';
    return 'preset-adult-female';
  }
  if (g === 'male') {
    if (isYoung)   return 'preset-young-boy';
    if (isElderly) return 'preset-elderly-male';
    return 'preset-adult-male';
  }
  // Unspecified gender — default to adult-male as a neutral fallback.
  return 'preset-adult-male';
}

/**
 * Slugify a name to a safe document identifier.
 * Mirrors the slugify() function in api/server.js.
 *
 * @param {string} str
 * @returns {string}
 */
function _slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Extract unique named (non-generic) character names from chapter content.
 * Returns every name found in [speaker:X] tags that is not narrator/male/female.
 *
 * @param {string} content
 * @returns {string[]}
 */
function _extractSpeakerNames(content) {
  const names = new Set();
  const re = /\[speaker:([A-Za-z0-9_-]+)\]/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const name = m[1];
    if (!GENERIC_SPEAKERS.has(name.toLowerCase())) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * After chapter generation, auto-create minimal character profiles for any
 * new named speakers found in [speaker:X] tags.  Already-profiled characters
 * (matched by lower-cased name) are skipped.  A small AI call is made for
 * each new character to infer role, gender, and personality from the chapter
 * text; errors are suppressed so chapter saving always succeeds.
 *
 * @param {string} storyId
 * @param {string} content - Full chapter text with [speaker:X] tags.
 * @param {object} aiOptions - Options forwarded to ai.ask().
 */
async function _extractNewCharacters(storyId, content, aiOptions) {
  const names = _extractSpeakerNames(content);
  if (!names.length) return;

  const existing = storyRag.listDocs(storyId, 'character');
  const existingNames = new Set(existing.map((c) => c.name.toLowerCase()));

  for (const name of names) {
    if (existingNames.has(name.toLowerCase())) continue;

    try {
      const descPrompt = [
        `You are a creative writing assistant. Based on the following chapter, describe the character named "${name}" briefly.`,
        'Respond with ONLY a valid JSON object with these fields:',
        '  "role": their role in the story (e.g. protagonist, villain, mentor, supporting)',
        '  "gender": one of "male", "female", "non-binary", or "" if unclear',
        '  "personality": 2-3 personality traits as a comma-separated string',
        '',
        'Chapter excerpt:',
        content.slice(0, 3000),
      ].join('\n');

      const raw = await ai.ask(descPrompt, aiOptions);

      let profile = { role: '', gender: '', personality: '' };
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          profile.role        = typeof parsed.role        === 'string' ? parsed.role.trim()        : '';
          profile.gender      = typeof parsed.gender      === 'string' ? parsed.gender.trim()      : '';
          profile.personality = typeof parsed.personality === 'string' ? parsed.personality.trim() : '';
        }
      } catch { /* use empty profile on parse failure */ }

      const voiceId = pickVoicePreset(profile.gender, profile.personality);
      const slug    = _slugify(name);
      const charId  = `char-${slug}`;

      const contentParts = [
        `Name: ${name}`,
        profile.role        ? `Role: ${profile.role}`               : '',
        profile.gender      ? `Gender: ${profile.gender}`           : '',
        profile.personality ? `Personality: ${profile.personality}` : '',
      ].filter(Boolean);

      storyRag.addDoc(storyId, {
        id:          charId,
        type:        'character',
        name,
        role:        profile.role,
        gender:      profile.gender,
        personality: profile.personality,
        backstory:   '',
        speechStyle: '',
        voiceId,
        content:     contentParts.join('. '),
      });

      // Keep existingNames up-to-date so duplicate names in the same chapter
      // are only processed once.
      existingNames.add(name.toLowerCase());
    } catch (e) {
      console.warn(`[story] Failed to auto-create character "${name}":`, e.message);
    }
  }
}

/** Default percentage of the chapter that should be character dialogue (0–100). */
const DEFAULT_DIALOG_RATIO = 60;

/**
 * Valid emotion presets understood by the Zonos TTS sidecar.
 * These must match the keys in _EMOTION_PRESETS in zonos/server.py.
 */
const EMOTION_PRESETS = ['neutral', 'happy', 'sad', 'calm', 'energetic', 'angry'];

/**
 * Normalise text returned by the AI so that literal `\n`/`\t` escape
 * sequences become real whitespace characters and surrounding whitespace
 * is removed.
 *
 * @param {string} text - Raw text, possibly containing literal escape sequences.
 * @returns {string}
 */
function normalizeText(text) {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim();
}

/**
 * Extract the outline, characters, and locations from the AI response for
 * story creation.  Falls back to the raw response text as the outline (with
 * empty characters and locations arrays) if JSON parsing fails or the outline
 * field is absent.
 *
 * @param {string} raw - Raw string from the AI.
 * @returns {{ outline: string, characters: Array<object>, locations: Array<object> }}
 */
function parseCreateResponse(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    const jsonStr = match[0];
    // Attempt 1: parse as-is
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.outline === 'string' && parsed.outline.trim()) {
        return _extractCreateFields(parsed);
      }
    } catch { /* try next */ }
    // Attempt 2: some models embed literal newlines inside JSON strings which
    // is invalid JSON — escape them first, then re-try
    try {
      const fixed = jsonStr.replace(/\r?\n/g, '\\n');
      const parsed = JSON.parse(fixed);
      if (typeof parsed.outline === 'string' && parsed.outline.trim()) {
        return _extractCreateFields(parsed);
      }
    } catch { /* fall through */ }
  }
  // Fallback: treat the entire raw response as the outline.
  return { outline: normalizeText(raw.trim()), characters: [], locations: [] };
}

/**
 * Extract and normalise the outline, characters, and locations fields from a
 * successfully-parsed AI JSON object.
 *
 * @param {object} parsed
 * @returns {{ outline: string, characters: Array<object>, locations: Array<object> }}
 */
function _extractCreateFields(parsed) {
  const outline = normalizeText(parsed.outline.trim());

  const characters = Array.isArray(parsed.characters)
    ? parsed.characters
        .filter((c) => c && typeof c.name === 'string' && c.name.trim())
        .map((c) => ({
          name:        c.name.trim(),
          role:        typeof c.role        === 'string' ? c.role.trim()        : '',
          gender:      typeof c.gender      === 'string' ? c.gender.trim()      : '',
          personality: typeof c.personality === 'string' ? c.personality.trim() : '',
          backstory:   typeof c.backstory   === 'string' ? c.backstory.trim()   : '',
        }))
    : [];

  const locations = Array.isArray(parsed.locations)
    ? parsed.locations
        .filter((l) => l && typeof l.title === 'string' && l.title.trim())
        .map((l) => ({
          title:       l.title.trim(),
          description: typeof l.description === 'string' ? l.description.trim() : '',
        }))
    : [];

  return { outline, characters, locations };
}

/**
 * Build a RAG-enriched character context block from story character profiles.
 * Returns a formatted multi-line string listing each character's name, role,
 * gender, personality, backstory, and speech style — or an empty string when
 * no characters have been defined for the story.
 *
 * @param {Array<object>} characters - Character docs from the story RAG store.
 * @returns {string} Formatted character context, or empty string when none exist.
 */
function buildCharacterContext(characters) {
  if (!characters.length) return '';
  const lines = ['Cast of Characters:'];
  for (const c of characters) {
    lines.push(`  ${c.name}${c.role ? ` (${c.role})` : ''}${c.gender ? `, ${c.gender}` : ''}`);
    if (c.personality) lines.push(`    Personality: ${c.personality}`);
    if (c.backstory) lines.push(`    Backstory: ${c.backstory}`);
    if (c.speechStyle) lines.push(`    Speech style: ${c.speechStyle}`);
  }
  return lines.join('\n');
}

/**
 * Build a RAG-enriched world context block from story lore entries.
 * Returns a formatted multi-line string of lore titles and their descriptions,
 * or an empty string when no lore entries have been defined for the story.
 *
 * @param {Array<object>} loreEntries - Lore docs from the story RAG store.
 * @returns {string} Formatted lore context, or empty string when none exist.
 */
function buildLoreContext(loreEntries) {
  if (!loreEntries.length) return '';
  const lines = ['World Context:'];
  for (const entry of loreEntries) {
    lines.push(`  [${entry.title}]`);
    lines.push(`  ${entry.content}`);
  }
  return lines.join('\n');
}

/**
 * Build the speaker-tag instruction line for the chapter prompt.
 * Uses character names when character profiles are defined; falls back to the
 * generic [speaker:male] / [speaker:female] format otherwise.
 *
 * @param {Array<object>} characters - Character docs from the story RAG store.
 * @returns {string} A single instruction sentence for the AI prompt.
 */
function buildSpeakerTagInstruction(characters) {
  if (!characters.length) {
    return 'Speaker tags: [speaker:narrator] for narrative prose, [speaker:male] for male character speech, [speaker:female] for female character speech.';
  }
  const examples = characters
    .slice(0, 4) // limit examples to 4 to keep the instruction line concise in the prompt
    .map((c) => `[speaker:${c.name}]`)
    .join(', ');
  return (
    `Speaker tags: [speaker:narrator] for narrative prose, and use the character's exact name in the speaker tag for their dialogue (e.g., ${examples}). ` +
    'For any unnamed characters not listed in the Cast above, use [speaker:male] or [speaker:female].'
  );
}

/**
 * Generate a brief summary of a chapter and store it in the story's RAG store.
 * Errors are logged as warnings and do not propagate — chapter saving must not
 * depend on summary generation succeeding.
 *
 * @param {string} storyId
 * @param {number} chapterNumber
 * @param {string} content - The generated chapter text.
 * @param {object} aiOptions - Options forwarded to ai.ask().
 */
async function _storeChapterSummary(storyId, chapterNumber, content, aiOptions) {
  const prompt = [
    'You are a creative writing assistant. Write a brief summary of the following chapter.',
    'The summary must be 2–4 sentences covering the key events, character moments, and plot developments.',
    'Respond with ONLY the summary text — no JSON, no explanation.',
    '',
    `Chapter ${chapterNumber}:`,
    content,
  ].join('\n');

  try {
    const summary = await ai.ask(prompt, aiOptions);
    storyRag.addDoc(storyId, {
      id: `summary-${chapterNumber}`,
      type: 'summary',
      chapterNumber,
      content: summary.trim(),
    });
  } catch (e) {
    // Intentionally suppress summary errors — chapter data has already been
    // written to disk and the caller should not see a failure just because
    // the optional post-processing step couldn't complete.
    console.warn('[story] Failed to generate summary for chapter:', chapterNumber, e.message);
  }
}

/**
 * Generate a chapter for an existing story and persist it to disk.
 *
 * Character profiles, lore entries, and chapter summaries stored in the
 * story's RAG store are automatically injected as context so the AI can
 * maintain consistency without the prompt growing unboundedly.
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

  const dialogRatio = (typeof aiOptions.dialogRatio === 'number')
    ? Math.max(0, Math.min(100, Math.round(aiOptions.dialogRatio)))
    : DEFAULT_DIALOG_RATIO;
  const narrationRatio = 100 - dialogRatio;

  // ── RAG-enriched context ────────────────────────────────────────────────────
  const characters = storyRag.listDocs(storyId, 'character');
  const loreEntries = storyRag.listDocs(storyId, 'lore');

  // Chapter summaries replace full prior-chapter text to keep the context window
  // from growing unboundedly as the story progresses.  Fall back to full text
  // for stories that pre-date the summary feature.
  const allSummaries = storyRag.listDocs(storyId, 'summary')
    .filter((d) => d.chapterNumber < chapterNumber)
    .sort((a, b) => a.chapterNumber - b.chapterNumber);

  let prior;
  if (allSummaries.length > 0) {
    prior = allSummaries
      .map((d) => `Chapter ${d.chapterNumber} Summary:\n${d.content}`)
      .join('\n\n');
  } else {
    // Fallback: full prior chapter text (original behaviour for existing stories).
    prior = (storyData.chapters || [])
      .filter((c) => c.number < chapterNumber)
      .sort((a, b) => a.number - b.number)
      .map((c) => `Chapter ${c.number}:\n${c.content}`)
      .join('\n\n');
  }

  const characterContext = buildCharacterContext(characters);
  const loreContext = buildLoreContext(loreEntries);
  const speakerTagInstruction = buildSpeakerTagInstruction(characters);

  const prompt = [
    'You are a creative writing assistant. Write a detailed, immersive chapter of a story.',
    'Respond with ONLY a valid JSON object containing exactly this field:',
    '  "content": the full chapter text as a single well-formatted string (prose paragraphs separated by blank lines)',
    '',
    'The chapter must be substantial: at least ' + CHAPTER_MIN_WORDS + ' words with vivid descriptions, meaningful dialogue, and strong pacing.',
    `Aim for approximately ${dialogRatio}% character dialogue and ${narrationRatio}% narration/description.`,
    'Dialogue lines and narrative description should each form their own paragraphs where possible.',
    '',
    'IMPORTANT — Speaker and emotion tagging for text-to-speech:',
    'Begin every paragraph with a speaker tag immediately followed by an emotion tag, before the paragraph text.',
    speakerTagInstruction,
    `Emotion tags: one of ${EMOTION_PRESETS.map((e) => `[emotion:${e}]`).join(', ')}.`,
    'For narrator paragraphs, use ONLY [emotion:neutral] or [emotion:calm]. Reserve expressive emotions for character dialogue.',
    'The tags are invisible to readers and are used only by the audio narration system.',
    'Use ONLY the square-bracket format shown above. Do NOT use quotes around the tags.',
    '',
    'CRITICAL RULE — Never mix dialogue and attribution in the same paragraph:',
    'When a character speaks AND the sentence contains a narrative attribution (e.g. "she said", "he murmured", "Alex whispered"),',
    'you MUST split them into SEPARATE paragraphs: one [speaker:character] paragraph for the quoted speech only,',
    'followed immediately by a [speaker:narrator] paragraph for the attribution and any following narration.',
    '',
    'Correct example (split into separate paragraphs):',
    '[speaker:female][emotion:curious] "I should look into this."',
    '[speaker:narrator][emotion:neutral] Alex murmured aloud, her voice barely audible over the rustling of papers.',
    '[speaker:female][emotion:curious] "Maybe there\'s something important I\'m missing."',
    '[speaker:narrator][emotion:neutral] She felt a mix of curiosity and trepidation, as if the future was whispering secrets.',
    '',
    'WRONG example (do NOT do this — dialogue and attribution mixed in one paragraph):',
    '[speaker:female][emotion:curious] "I should look into this," Alex murmured aloud, her voice barely audible.',
    '',
    'Further examples:',
    '[speaker:narrator][emotion:neutral] The old house creaked as she stepped inside.',
    '[speaker:male][emotion:happy] "We finally made it!"',
    '[speaker:narrator][emotion:neutral] Thomas shouted, punching the air.',
    '[speaker:female][emotion:sad] "I\'m so sorry."',
    '[speaker:narrator][emotion:neutral] Elena whispered softly, turning away.',
    '',
    'Do not include any explanation or text outside the JSON object.',
    '',
    `Title: ${storyData.title}`,
    `Genre: ${storyData.genre}`,
    `Tone: ${storyData.tone}`,
    `Outline:\n${storyData.outline}`,
    characterContext ? `\n${characterContext}` : '',
    loreContext ? `\n${loreContext}` : '',
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

  // Generate and store a summary of this chapter for future continuity context.
  await _storeChapterSummary(storyId, chapterNumber, content, aiOptions);

  // Auto-create character profiles for any new named speakers in the chapter.
  await _extractNewCharacters(storyId, content, aiOptions);

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
    const jsonStr = match[0];
    // Attempt 1: parse as-is
    try {
      const parsed = JSON.parse(jsonStr);
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return normalizeText(parsed.content.trim());
      }
    } catch { /* try next */ }
    // Attempt 2: escape unescaped literal newlines inside JSON string values
    // (a common pattern for AI models that don't strictly format JSON)
    try {
      const fixed = jsonStr.replace(/\r?\n/g, '\\n');
      const parsed = JSON.parse(fixed);
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return normalizeText(parsed.content.trim());
      }
    } catch { /* fall through */ }
  }
  return normalizeText(raw.trim());
}

/**
 * Update the content of an existing chapter in a story on disk.
 * Only the `content` field of the chapter is changed; `number` and `createdAt`
 * are preserved.
 *
 * @param {string} storyId       - The story ID.
 * @param {number} chapterNumber - 1-based chapter number to update.
 * @param {string} content       - New chapter content (may include speaker/emotion tags).
 * @returns {{ storyId: string, chapterNumber: number, content: string }}
 */
function updateChapterContent(storyId, chapterNumber, content) {
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

  storyData.chapters[idx] = { ...storyData.chapters[idx], content };
  fs.writeFileSync(filepath, JSON.stringify(storyData, null, 2), 'utf8');

  return { storyId, chapterNumber, content };
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

  // Remove the chapter summary from the story RAG store so future chapter
  // generation does not reference a summary for a deleted chapter.
  storyRag.removeDoc(storyId, `summary-${chapterNumber}`);

  return { storyId, chapterNumber };
}

/**
 * Delete an entire story (its JSON file) from disk.
 *
 * @param {string} storyId - The story ID.
 * @returns {{ storyId: string }}
 */
function deleteStory(storyId) {
  const filename = `${storyId}.json`;
  const filepath = path.join(STORIES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Story not found: ${storyId}`);
  }

  fs.unlinkSync(filepath);

  // Remove all per-story RAG documents (character profiles, lore, summaries).
  storyRag.clearStory(storyId);

  return { storyId };
}

module.exports = { create, generateChapter, updateChapterContent, deleteChapter, deleteStory, list, get, pickVoicePreset };

/**
 * Return summary metadata for every saved story, newest first.
 *
 * @returns {Array<{id, title, genre, tone, outline, createdAt, chapterCount}>}
 */
function list() {
  if (!fs.existsSync(STORIES_DIR)) return [];
  return fs.readdirSync(STORIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, f), 'utf8'));
        return {
          id: data.id,
          title: data.title,
          genre: data.genre,
          tone: data.tone,
          outline: data.outline,
          createdAt: data.createdAt,
          chapterCount: (data.chapters || []).length,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Load the full data for a single story (including chapters).
 *
 * @param {string} storyId - The story ID.
 * @returns {{id, title, genre, tone, outline, createdAt, chapters: Array}}
 */
function get(storyId) {
  const filename = path.basename(`${storyId}.json`);
  const filepath = path.join(STORIES_DIR, filename);
  if (!fs.existsSync(filepath)) throw new Error(`Story not found: ${storyId}`);
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

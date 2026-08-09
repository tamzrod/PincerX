'use strict';

const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const storyRag = require('./story-rag');
const coherence = require('./story-coherence');
const experience = require('./story-experience');
const localization = require('./story-localization');

// Overridable via env so test files can isolate their stories directory and
// avoid racing with parallel Jest workers that share data/stories/ by default.
const STORIES_DIR = process.env.PINCERX_STORIES_DIR
  ? path.resolve(process.env.PINCERX_STORIES_DIR)
  : path.join(__dirname, '..', 'data', 'stories');

/**
 * Generate a story outline using AI and persist it to disk.
 * Also seeds the story's RAG store with an initial cast of characters and
 * key locations extracted from the same AI response.
 *
 * @param {string} title   - The story title.
 * @param {string} genre   - The story genre (e.g. "fantasy", "thriller").
 * @param {string} tone    - The desired tone (e.g. "dark", "humorous").
 * @param {object} [aiOptions] - Options forwarded to ai.ask().
 * @param {string} [customPrompt] - Optional user instructions appended to the outline prompt.
 * @param {string} [localizationStyle] - Optional Name & Place Localization style
 *   (machine id or display label). When set and valid, the style is stored as
 *   the story's localization config and the initial cast/locations are
 *   localized so canonical names are used from the very first chapter.
 * @returns {Promise<{id: string, title: string, genre: string, tone: string, outline: string, createdAt: string}>}
 */
async function create(title, genre, tone, aiOptions = {}, customPrompt = '', localizationStyle = '') {
  const onPhase = aiOptions.onPhase;
  const onToken = aiOptions.onToken;
  const custom = typeof customPrompt === 'string' ? customPrompt.trim() : '';
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
    custom ? `\nAdditional instructions: ${custom}` : '',
  ].join('\n');

  if (onPhase) onPhase('Generating outline');
  const raw = onToken
    ? await ai.askStream(prompt, aiOptions, onToken)
    : await ai.ask(prompt, aiOptions);
  const { outline, characters, locations } = parseCreateResponse(raw);

  const id = `${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  const createdAt = new Date().toISOString();
  const storyObj = { id, title, genre, tone, outline, createdAt };

  fs.mkdirSync(STORIES_DIR, { recursive: true });
  const filename = path.basename(`${id}.json`);
  fs.writeFileSync(path.join(STORIES_DIR, filename), JSON.stringify(storyObj, null, 2), 'utf8');

  // Seed the story RAG store with the initial cast of characters.
  if (onPhase) onPhase('Saving characters');
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

  // ── Name & Place Localization (optional, opt-in) ──────────────────────────
  // When the author selects a localization style at creation time, store it as
  // the story's localization config and localise the initial cast + locations
  // so canonical names are used from the very first chapter. Soft-fails: a
  // localization error never blocks story creation (the outline is already
  // saved); the config is still stored so the author can retry via "Localize
  // Story Names".
  if (localizationStyle) {
    const { valid, normalized } = localization.validateConfig({ style: localizationStyle });
    if (valid) {
      storyRag.setLocalizationConfig(id, normalized);
      if (normalized.style !== 'original') {
        try {
          if (onPhase) onPhase('Localizing names');
          const sourceEntities = []
            .concat(characters.map((c) => ({ name: c.name, type: 'character' })))
            .concat(locations.map((l) => ({ name: l.title, type: 'place' })))
            .filter((e) => e.name);
          await localization.localizeEntities(id, sourceEntities, aiOptions);
        } catch (e) {
          console.warn('[story] Initial name localization failed:', e.message);
        }
      }
    }
  }

  if (onPhase) onPhase('Done');
  return storyObj;
}

/**
 * Chapter length presets and their word count targets.
 * @typedef {'short' | 'default' | 'long'} ChapterLength
 */
const CHAPTER_LENGTH_PRESETS = {
  short: { minWords: 800, targetWords: 1100, maxWords: 1400 },
  default: { minWords: 1400, targetWords: 1900, maxWords: 2400 },
  long: { minWords: 2500, targetWords: 3200, maxWords: 4000 },
};

/**
 * Rough tokens-per-word estimate used to size the model's generation budget.
 * 1 word ≈ 1.3 tokens on average; we pad generously so the model is never
 * cut off short of the requested length. Capped to keep requests sane.
 */
const TOKENS_PER_WORD = 1.6;
const MAX_TOKEN_BUDGET = 8192;

/**
 * Compute a generation token budget (max output tokens) for a chapter from
 * the active length preset or explicit word target.
 * @param {string} length
 * @param {number} [wordTarget]
 * @returns {number}
 */
function chapterTokenBudget(length, wordTarget) {
  const preset = CHAPTER_LENGTH_PRESETS[length] || CHAPTER_LENGTH_PRESETS.default;
  const words = (typeof wordTarget === 'number' && wordTarget > 0) ? wordTarget : preset.maxWords;
  return Math.min(MAX_TOKEN_BUDGET, Math.max(1024, Math.round(words * TOKENS_PER_WORD)));
}

/** Generic speaker names that are never real character profiles. */
const GENERIC_SPEAKERS = new Set(['narrator', 'male', 'female']);

/**
 * Build a LENGTH POLICY block for the chapter generation prompt.
 * Returns clear, mandatory word count guidance based on the length preset.
 *
 * @param {string} length - 'short', 'default', or 'long'
 * @param {number} [wordTarget] - Optional exact word target (overrides preset)
 * @returns {string} Formatted length policy text
 */
function buildLengthPolicy(length, wordTarget) {
  if (typeof wordTarget === 'number' && wordTarget > 0) {
    const tolerance = Math.round(wordTarget * 0.1);
    return [
      'LENGTH POLICY (MANDATORY):',
      `Your chapter must be exactly ${wordTarget} words (±${tolerance} words acceptable).`,
      'This is not a suggestion — the chapter will be rejected if it falls outside this range.',
      'Ensure every paragraph contributes meaningful content: vivid descriptions, character thoughts, plot development.',
      'Do not pad with filler or repeat established information.',
      'Structure: opening hook → rising action → midpoint → climax → closing hook or cliffhanger.',
    ].join('\n');
  }

  const preset = CHAPTER_LENGTH_PRESETS[length] || CHAPTER_LENGTH_PRESETS.default;
  return [
    'LENGTH POLICY (MANDATORY):',
    `Your chapter must be ${preset.minWords}–${preset.maxWords} words.`,
    `Aim for approximately ${preset.targetWords} words.`,
    'This is not a suggestion — the chapter will be rejected if it falls below the minimum.',
    '',
    'Ensure the length is real content, not padding:',
    '- Vivid sensory descriptions of settings and atmosphere',
    '- Character thoughts, emotions, and internal conflicts',
    '- Meaningful plot advancement and character development',
    '- Natural dialogue that reveals character and advances story',
    '',
    'Structure your chapter with:',
    '- Opening hook that draws readers in',
    '- Rising action that builds tension',
    '- Midpoint or turning point',
    '- Climax or dramatic moment',
    '- Closing hook or cliffhanger that compels reading the next chapter',
    '',
    'Do NOT end a chapter with a vague tease like "ordinary day" when the genre demands more.',
  ].join('\n');
}

// ── Chapter resume (timeout recovery) ───────────────────────────────────────
// A streaming chapter generation that is interrupted by a timeout / connection
// failure after producing partial content preserves that content as a "partial"
// chapter (status:"partial"). The user may then RESUME — continue writing from
// the exact end of the existing text — rather than regenerate from scratch.

/** Approximate word count for a chunk of text (used to size the resume budget). */
function wordCount(text) {
  if (typeof text !== 'string' || text.trim() === '') return 0;
  return text.trim().split(/\s+/).length;
}

/**
 * Build a generation budget for the REMAINING portion of a chapter being
 * resumed. The total chapter length (initial generation + all resumes) stays
 * bounded by the configured chapter length policy; only the unfilled portion is
 * requested from the model.
 *
 * @param {string} length - Length preset key.
 * @param {number} [wordTarget] - Explicit total word target (if any).
 * @param {number} alreadyGeneratedWords - Words already present in the partial.
 * @returns {{ remainingWords: number, maxTokens: number }}
 */
function resumeTokenBudget(length, wordTarget, alreadyGeneratedWords) {
  const preset = CHAPTER_LENGTH_PRESETS[length] || CHAPTER_LENGTH_PRESETS.default;
  const totalWords = (typeof wordTarget === 'number' && wordTarget > 0)
    ? wordTarget
    : preset.targetWords;
  const remainingWords = Math.max(1, totalWords - Math.max(0, alreadyGeneratedWords));
  // Same tokens-per-word heuristic as chapterTokenBudget, but never floors at
  // 1024 (a resume often needs far fewer tokens than a full chapter).
  const maxTokens = Math.min(
    MAX_TOKEN_BUDGET,
    Math.max(256, Math.round(remainingWords * TOKENS_PER_WORD))
  );
  return { remainingWords, maxTokens };
}

/**
 * Remove leading overlap where the model repeated the tail of the existing
 * partial text at the start of its continuation. Searches the last
 * `maxOverlapChars` characters of `existing` for the longest suffix that is also
 * a prefix of `continuation`, and strips it from `continuation`.
 *
 * @param {string} existing - The already-written partial chapter text.
 * @param {string} continuation - The newly generated continuation text.
 * @param {number} [maxOverlapChars] - Limit the overlap search window.
 * @returns {string} The continuation with any duplicate opening removed.
 */
function stripContinuationOverlap(existing, continuation, maxOverlapChars = 600) {
  if (typeof existing !== 'string' || typeof continuation !== 'string') return continuation;
  const a = existing.trimEnd();
  const b = continuation.trimStart();
  if (!a || !b) return continuation;
  const tail = a.slice(-maxOverlapChars);
  let best = 0;
  // Try every suffix length of `tail` to find one that prefixes `b`.
  for (let len = Math.min(tail.length, b.length); len > 0; len--) {
    if (tail.endsWith(b.slice(0, len))) { best = len; break; }
  }
  if (best === 0) return continuation;
  return continuation.slice(best);
}

/**
 * Build the continuation prompt for a chapter RESUME. The model is asked to
 * continue from the EXACT end of the existing partial text — never to repeat or
 * rewrite it. Only the REMAINING word budget is requested so the cumulative
 * chapter length stays bounded. Coherence constraints (characters, lore, prior
 * summaries, story law) and the Reader Experience objective are preserved so the
 * resumed section is still part of the same chapter.
 *
 * @param {object} p
 * @returns {string}
 */
function _buildResumePrompt(p) {
  // Provide the tail of the existing text as the anchor for continuation. If the
  // full partial is short enough, include it whole; otherwise include only the
  // last portion (enough to maintain continuity) and explicitly tell the model
  // the earlier text already exists and must not be reproduced.
  const MAX_EXISTING_CHARS = 4000;
  const full = p.existingPartial;
  const includeTail = full.length > MAX_EXISTING_CHARS;
  const existingContext = includeTail ? full.slice(-MAX_EXISTING_CHARS) : full;

  return [
    'You are a creative writing assistant continuing an interrupted chapter.',
    'This chapter was interrupted during generation. Continue writing from the EXACT end of the existing text.',
    '',
    'CRITICAL CONTINUATION RULES:',
    '- Do NOT repeat, rewrite, paraphrase, or restart any existing text.',
    '- Do NOT restart the chapter or re-introduce the opening.',
    '- Continue naturally from the final sentence of the existing text.',
    '- The following text already exists. Do NOT reproduce it.',
    '- Maintain the established characters, world knowledge, narrative state,',
    '  Reader Experience objective, and coherence constraints.',
    '- Complete the chapter according to the length policy below.',
    '',
    'Respond with ONLY a valid JSON object containing exactly this field:',
    '  "content": the CONTINUATION text only (NOT the whole chapter) as a single well-formatted string (prose paragraphs separated by blank lines)',
    '',
    p.remainingLengthPolicy,
    `Approximately ${p.remainingWords} words REMAIN in this chapter's budget. Do not exceed it.`,
    '',
    'FORMATTING RULES (same as the original chapter):',
    '- Separate every paragraph with a blank line (double newline).',
    '- Begin EVERY paragraph with a [speaker:X][emotion:Y] tag.',
    `  emotion must be one of: ${EMOTION_PRESETS.map((e) => `[emotion:${e}]`).join(', ')}.`,
    '',
    p.speakerTagInstruction,
    '',
    `Title: ${p.title}`,
    `Genre: ${p.genre}`,
    `Tone: ${p.tone}`,
    `Outline:\n${p.outline}`,
    p.storyLawBlock ? `\n${p.storyLawBlock}` : '',
    p.canonicalNamesBlock ? `\n${p.canonicalNamesBlock}` : '',
    p.characterContext ? `\n${p.characterContext}` : '',
    p.loreContext ? `\n${p.loreContext}` : '',
    p.prior ? `\nPreviously written chapters:\n${p.prior}` : '',
    p.experienceObjectiveBlock || '',
    p.customPrompt ? `\nAdditional instructions: ${p.customPrompt}` : '',
    '',
    '═══════════════════════════════════════════════════════════════',
    'EXISTING CHAPTER TEXT (already written — DO NOT reproduce):',
    '═══════════════════════════════════════════════════════════════',
    includeTail ? '…(earlier text omitted, already written)…' : '',
    existingContext.trimEnd(),
    '═══════════════════════════════════════════════════════════════',
    `Now continue Chapter ${p.chapterNumber} from the exact end of the text above. Output ONLY the continuation.`,
  ].filter(Boolean).join('\n');
}


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
  // Allow spaces in speaker names so multi-word canonical names (e.g.
  // "Cedric Vale", "Isabella Hart") produced by Name & Place Localization
  // are captured correctly rather than truncated to the first token.
  const re = /\[speaker:([A-Za-z0-9 _-]+)\]/g;
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

/**
 * Valid emotion presets understood by the Zonos TTS sidecar.
 * These must match the keys in _EMOTION_PRESETS in zonos/server.py.
 */
const EMOTION_PRESETS = ['neutral', 'happy', 'sad', 'calm', 'energetic', 'angry'];

/**
 * Build the STORY LAW / KNOWLEDGE block for chapter generation prompts.
 * This is the primary anti-hallucination mechanism - it ensures the model
 * has access to all established story rules, boundaries, and world state.
 *
 * @param {string} storyId - The story ID
 * @param {object} storyData - The story metadata (genre, tone, etc.)
 * @returns {string} Formatted knowledge block for the prompt
 */
function buildStoryLawBlock(storyId, storyData) {
  // Get formatted knowledge from story-rag
  const knowledge = storyRag.formatKnowledgeForPrompt(storyId, {
    includeCharacters: true,
    includePlaces: true,
    includeLore: true,
    includeSystems: true,
    includeParameters: true,
    includeArcBoundaries: true,
    includeSummaries: true,
    maxChars: 4000, // More generous for the main knowledge block
  });

  if (!knowledge) {
    return '';
  }

  return [
    '═══════════════════════════════════════════════════════════════',
    'STORY LAW / KNOWLEDGE — Established Rules & Boundaries',
    '═══════════════════════════════════════════════════════════════',
    '',
    knowledge,
    '',
    '═══════════════════════════════════════════════════════════════',
    'STORY FUNDAMENTALS',
    `Title: ${storyData.title}`,
    `Genre: ${storyData.genre}`,
    `Tone: ${storyData.tone}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    'IMPORTANT: You MUST follow all rules above. Do not contradict Story Law.',
    'If introducing new elements, they must be consistent with established boundaries.',
  ].join('\n');
}

/**
 * Extract knowledge elements from a newly generated chapter.
 * This is the auto-growth mechanism that expands the knowledge base.
 *
 * @param {string} storyId
 * @param {number} chapterNumber
 * @param {string} content - The generated chapter text
 * @param {object} aiOptions - Options forwarded to ai.ask()
 */
async function _extractChapterKnowledge(storyId, chapterNumber, content, aiOptions) {
  const prompt = [
    'You are a creative writing assistant analyzing a chapter to extract canonical story knowledge.',
    'Extract ONLY clearly established facts, rules, and boundaries that should be remembered.',
    'Respond with ONLY a valid JSON object with an "extractions" array.',
    '',
    'Rules for extraction:',
    '- Only extract things explicitly stated in the chapter',
    '- Do NOT speculate or infer beyond what is written',
    '- Be conservative: if uncertain, do not extract',
    '- Focus on: new characters, new places, world rules, magic/tech systems, arc constraints',
    '',
    'JSON format:',
    '{',
    '  "extractions": [',
    '    { "type": "character", "id": "char-slug", "name": "...", "role": "...", "gender": "...", "personality": "...", "context": "...", "sourceChapter": N },',
    '    { "type": "place", "id": "place-slug", "title": "...", "content": "...", "constraints": "...", "context": "...", "sourceChapter": N },',
    '    { "type": "system", "id": "system-slug", "title": "...", "content": "...", "domain": "magic|tech|cultivation|science", "context": "...", "boundary": "...", "sourceChapter": N },',
    '    { "type": "arc_boundary", "id": "arc-slug", "title": "...", "phase": "...", "content": "...", "allowedEvents": [], "forbiddenEvents": [], "context": "...", "boundary": "...", "sourceChapter": N },',
    '    { "type": "lore", "id": "lore-slug", "title": "...", "content": "...", "context": "...", "sourceChapter": N }',
    '  ]',
    '}',
    '',
    'Chapter content:',
    content.slice(0, 4000),
  ].join('\n');

  try {
    const raw = await ai.ask(prompt, aiOptions);
    const parsed = parseChapterContent(raw);

    // Try to extract JSON from the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;

    let extracted;
    try {
      extracted = JSON.parse(match[0]);
    } catch {
      // Try with fixed newlines
      try {
        extracted = JSON.parse(match[0].replace(/\r?\n/g, '\\n'));
      } catch {
        return;
      }
    }

    if (!extracted || !Array.isArray(extracted.extractions) || extracted.extractions.length === 0) {
      return;
    }

    // Get existing docs to check for duplicates
    const existing = storyRag.loadDocs ? storyRag.loadDocs(storyId) : [];
    const existingIds = new Set(existing.map((d) => d.id));
    const existingNames = new Set(existing.filter((d) => d.name).map((d) => d.name.toLowerCase()));
    const existingTitles = new Set(existing.filter((d) => d.title).map((d) => d.title.toLowerCase()));

    const toAdd = [];
    for (const item of extracted.extractions) {
      if (!item.type || !storyRag.isValidType(item.type)) continue;

      // Skip if already exists by id, name, or title
      if (item.id && existingIds.has(item.id)) continue;
      if (item.name && existingNames.has(item.name.toLowerCase())) continue;
      if (item.title && existingTitles.has(item.title.toLowerCase())) continue;

      // Generate slug for id if not provided
      if (!item.id) {
        const base = item.name || item.title || `item-${Date.now()}`;
        item.id = `${item.type}-${storyRag._slugify(base)}`;
      }

      // Add source chapter
      item.sourceChapter = chapterNumber;

      toAdd.push(item);
    }

    if (toAdd.length > 0) {
      storyRag.batchUpsert(storyId, toAdd);
    }
  } catch (e) {
    // Suppress errors - knowledge extraction is optional
    console.warn('[story] Failed to extract knowledge from chapter:', chapterNumber, e.message);
  }
}

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
 * Lightweight chapter content normalizer that ensures paragraph breaks exist.
 *
 * If the content has no double newlines (i.e., is a wall-of-text), this function
 * splits it into paragraphs on safe boundaries:
 *   - [speaker:X] tags (start of a new paragraph when followed by content)
 *   - Dialogue/narration transitions (quoted speech followed by attribution)
 *
 * This function does NOT invent story content; it only restructures existing content.
 * Existing [speaker] and [emotion] tags are preserved.
 *
 * @param {string} content - Raw chapter content, possibly lacking paragraph breaks.
 * @returns {string} Content with proper paragraph separation.
 */
function normalizeChapterParagraphs(content) {
  if (!content || typeof content !== 'string') return content;

  // Already has paragraph breaks — normalize line endings and return
  if (content.includes('\n\n')) {
    return content
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Single-block wall-of-text — needs paragraphization
  const paragraphs = [];
  let remaining = content;

  // Pattern 1: split before [speaker:X] tags (they start new paragraphs)
  const speakerParts = remaining.split(/(\[[speaker:][^\]]+\])/);
  let current = '';

  for (const part of speakerParts) {
    if (/^\[speaker:/.test(part)) {
      // Save accumulated content before this speaker tag as a paragraph
      if (current.trim()) {
        paragraphs.push(current.trim());
      }
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) {
    paragraphs.push(current.trim());
  }

  // Pattern 2: split dialogue-attribution pairs within paragraphs
  // When we see dialogue ending with " and followed by attribution,
  // split them into separate paragraphs
  const finalParagraphs = [];
  for (const para of paragraphs) {
    // Check if paragraph contains both dialogue and attribution
    const dialogueAttrSplit = para.split(/([""][^""\n]+[""][,]\s+[A-Z][a-z]+(?:[a-z]+)?\s+(?:said|whispered|murmured|shouted|cried|asked|replied|answered|exclaimed|stated|continued|began|added|explained|remarked|nodded|shook|called|laughed|smiled|frowned|glanced|looked|sighed|paused|hesitated|reconsidered|agreed|disagreed|confirmed|denied|admitted|confessed|warned|reminded|noticed|realized|thought|remembered|dreamt|imagined|sensed|felt|feared|dreaded|hoped|wished|wanted|needed|desired|longing|craved|loved|hated|envied|resented|blamed|credited|thanked|apologized|insisted|promised|swore|declined|refused))/gi);

    if (dialogueAttrSplit.length > 1) {
      // First part is dialogue, rest is attribution
      for (let i = 0; i < dialogueAttrSplit.length; i++) {
        const segment = dialogueAttrSplit[i].trim();
        if (segment) {
          // Ensure each segment starts with a speaker tag if it's dialogue
          if (i === 0 && segment.startsWith('"')) {
            finalParagraphs.push('[speaker:narrator][emotion:neutral] ' + segment);
          } else if (segment) {
            finalParagraphs.push(segment);
          }
        }
      }
    } else {
      finalParagraphs.push(para);
    }
  }

  // Join with blank lines
  return finalParagraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
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
 * When `resolveName` is provided (Name & Place Localization active), each
 * character's name is resolved to its canonical display name so the cast list
 * shown to the model uses the canonical identity.
 *
 * @param {Array<object>} characters - Character docs from the story RAG store.
 * @param {function} [resolveName] - Optional (name) => canonicalName resolver.
 * @returns {string} Formatted character context, or empty string when none exist.
 */
function buildCharacterContext(characters, resolveName) {
  if (!characters.length) return '';
  const resolve = typeof resolveName === 'function' ? resolveName : ((n) => n);
  const lines = ['Cast of Characters:'];
  for (const c of characters) {
    const name = resolve(c.name);
    lines.push(`  ${name}${c.role ? ` (${c.role})` : ''}${c.gender ? `, ${c.gender}` : ''}`);
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
 * When `resolveName` is provided, lore titles are resolved to canonical names.
 *
 * @param {Array<object>} loreEntries - Lore docs from the story RAG store.
 * @param {function} [resolveName] - Optional (name) => canonicalName resolver.
 * @returns {string} Formatted lore context, or empty string when none exist.
 */
function buildLoreContext(loreEntries, resolveName) {
  if (!loreEntries.length) return '';
  const resolve = typeof resolveName === 'function' ? resolveName : ((n) => n);
  const lines = ['World Context:'];
  for (const entry of loreEntries) {
    lines.push(`  [${resolve(entry.title)}]`);
    lines.push(`  ${entry.content}`);
  }
  return lines.join('\n');
}

/**
 * Build the speaker-tag instruction line for the chapter prompt.
 * Uses character names when character profiles are defined; falls back to the
 * generic [speaker:male] / [speaker:female] format otherwise.
 *
 * When `resolveName` is provided, speaker-tag examples use canonical names so
 * the model emits [speaker:Cedric Vale] rather than the source name.
 *
 * @param {Array<object>} characters - Character docs from the story RAG store.
 * @param {function} [resolveName] - Optional (name) => canonicalName resolver.
 * @returns {string} A single instruction sentence for the AI prompt.
 */
function buildSpeakerTagInstruction(characters, resolveName) {
  const resolve = typeof resolveName === 'function' ? resolveName : ((n) => n);
  if (!characters.length) {
    return 'Speaker tags: [speaker:narrator] for narrative prose, [speaker:male] for male character speech, [speaker:female] for female character speech.';
  }
  const examples = characters
    .slice(0, 4) // limit examples to 4 to keep the instruction line concise in the prompt
    .map((c) => `[speaker:${resolve(c.name)}]`)
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
 *   @param {string} [aiOptions.length] - 'short', 'default', or 'long' (default: 'default').
 *   @param {number} [aiOptions.wordTarget] - Exact word target (overrides length preset).
 *   @param {object} [aiOptions.resume] - Resume a timed-out partial chapter. When
 *     present, the existing partial chapter text is continued from its exact end
 *     (no rewrite). May carry `{ content, experienceObjective, length, wordTarget,
 *     model }`; missing fields are read from the stored partial chapter.
 *   @param {object} [aiOptions.regenerate] - Coherence-guided full rewrite (see below).
 * @param {string} [customPrompt] - Optional extra instructions for the AI.
 * @returns {Promise<object>} On completion: `{ storyId, chapterNumber, content,
 *   status:"complete", coherence, experience, experienceObjective }`. On a
 *   timeout that preserved partial content: `{ storyId, chapterNumber, content,
 *   status:"partial", reason, resumeAvailable:true }` (no summary/coherence is
 *   stored for a partial chapter).
 */
async function generateChapter(storyId, chapterNumber, aiOptions = {}, customPrompt = '') {
  const filename = path.basename(`${storyId}.json`);
  const filepath = path.join(STORIES_DIR, filename);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Story not found: ${storyId}`);
  }

  const storyData = JSON.parse(fs.readFileSync(filepath, 'utf8'));

  // ── Resume (timeout recovery) ──────────────────────────────────────────────
  // Resume continues an interrupted partial chapter from its exact end. It is a
  // distinct operation from regenerate (a full rewrite). The existing partial is
  // loaded from disk (or taken from aiOptions.resume.content), and the model is
  // asked ONLY for the remaining portion of the chapter.
  const resume = aiOptions.resume;
  const isResume = Boolean(resume);

  // When resuming, prefer the generation params captured on the partial chapter
  // (length/wordTarget/model) so the resume matches the original intent rather
  // than whatever the caller happened to pass this time.
  const partialChapter = isResume
    ? (storyData.chapters || []).find((c) => c.number === chapterNumber && c.status === 'partial')
    : null;
  const resumeGen = (partialChapter && partialChapter.generation) || {};

  // Chapter length: default to 'default' when not specified
  const length = (() => {
    if (isResume) {
      const r = resume.length || resumeGen.length || aiOptions.length;
      if (r === 'short' || r === 'long') return r;
      return 'default';
    }
    return (aiOptions.length === 'short' || aiOptions.length === 'long') ? aiOptions.length : 'default';
  })();
  const wordTarget = (() => {
    if (isResume) {
      const r = (typeof resume.wordTarget === 'number' && resume.wordTarget > 0)
        ? resume.wordTarget
        : (typeof resumeGen.wordTarget === 'number' && resumeGen.wordTarget > 0 ? resumeGen.wordTarget : aiOptions.wordTarget);
      return (typeof r === 'number' && r > 0) ? r : undefined;
    }
    return (typeof aiOptions.wordTarget === 'number' && aiOptions.wordTarget > 0) ? aiOptions.wordTarget : undefined;
  })();

  // The existing partial content to continue from.
  const existingPartial = isResume
    ? (typeof resume.content === 'string' && resume.content.trim()
        ? resume.content
        : (partialChapter ? partialChapter.content : ''))
    : '';

  // ── RAG-enriched context ────────────────────────────────────────────────────
  const characters = storyRag.listDocs(storyId, 'character');
  const loreEntries = storyRag.listDocs(storyId, 'lore');

  // ── Name & Place Localization (canonical identity) ───────────────────────
  // When localization is active, load the entity map once and resolve names to
  // their canonical display names in the character/lore/speaker-tag context.
  // The canonical-names block is also injected into the prompt so the model
  // uses canonical names consistently (and never reverts on regeneration).
  const locMap = localization.isActive(storyId) ? localization.loadEntityMap(storyId) : null;
  const resolveName = locMap
    ? (name) => localization.resolveNameWithMap(locMap, name)
    : null;
  const canonicalNamesBlock = locMap ? localization.buildCanonicalNamesBlock(storyId) : '';

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

  const characterContext = buildCharacterContext(characters, resolveName);
  const loreContext = buildLoreContext(loreEntries, resolveName);
  const speakerTagInstruction = buildSpeakerTagInstruction(characters, resolveName);
  const storyLawBlock = buildStoryLawBlock(storyId, storyData);
  const lengthPolicy = buildLengthPolicy(length, wordTarget);

  // Give the model a generation budget sized to the requested length so it
  // isn't artificially capped short of the word target (the default Ollama /
  // OpenAI budget can be far smaller than a full chapter needs).
  //
  // When resuming, the budget covers only the REMAINING portion of the chapter
  // (target − already-generated) so the cumulative length stays bounded.
  let resumeBudget = null;
  if (isResume) {
    resumeBudget = resumeTokenBudget(length, wordTarget, wordCount(existingPartial));
  }
  const askOptions = {
    ...aiOptions,
    maxTokens: isResume ? resumeBudget.maxTokens : chapterTokenBudget(length, wordTarget),
  };
  // Resume must use the SAME model as the original generation. Prefer the
  // caller-provided model, then the model captured on the partial chapter.
  if (isResume && !askOptions.model && resumeGen.model) {
    askOptions.model = resumeGen.model;
  }

  // Optional live-progress hooks (used by the streaming endpoint to surface
  // the AI conversation in the UI). onPhase(label) marks a generation phase;
  // onToken(chunk, meta) streams token fragments. When onToken is provided we
  // stream the chapter generation so the user sees text appear in real time.
  const onPhase = aiOptions.onPhase;
  const onToken = aiOptions.onToken;

  // Coherence-guided regeneration: when `aiOptions.regenerate` is present we
  // are re-writing an EXISTING chapter to fix a detected coherence issue. The
  // recommendation must always be honored; an optional customInstruction is an
  // additional creative constraint that must NOT override the coherence fix.
  const regenerate = aiOptions.regenerate;
  const isRegen = Boolean(regenerate);
  const originalChapter = isRegen
    ? (storyData.chapters || []).find((c) => c.number === chapterNumber)
    : null;
  const originalContent = originalChapter ? originalChapter.content : '';

  const coherenceRegenBlock = isRegen ? [
    '',
    '═══════════════════════════════════════════════════════════════',
    'COHERENCE-GUIDED REGENERATION',
    '═══════════════════════════════════════════════════════════════',
    'You are regenerating an EXISTING chapter to fix a detected coherence issue.',
    'Preserve the chapter\'s intended events, continuity, and narrative purpose.',
    'Do NOT introduce unrelated changes.',
    '',
    regenerate.evidence
      ? `Address the detected coherence issue:\n${regenerate.evidence}`
      : '',
    regenerate.recommendation
      ? `Follow this recommendation:\n${regenerate.recommendation}`
      : '',
    regenerate.customInstruction
      ? 'Also apply the following user instruction (an ADDITIONAL creative constraint —\ndo NOT ignore the coherence correction merely because this is provided):\n' + regenerate.customInstruction
      : '',
    originalContent
      ? `Original chapter (for reference — preserve its events and narrative purpose):\n${originalContent}`
      : '',
    '',
    'Produce a COMPLETE replacement chapter.',
    '═══════════════════════════════════════════════════════════════',
  ].filter(Boolean).join('\n') : '';

  // ── Reader Experience synthesis (soft, opt-in) ────────────────────────────
  // Synthesis only runs when the author has configured Reader Experience for
  // this story (a config doc in the RAG store). When inactive, behaviour is
  // identical to the pre-feature pipeline. On any failure the previous Reader
  // Experience state is preserved and chapter generation continues normally.
  let experienceObjective = null;
  let experienceSynthesis = null;
  if (storyRag.getExperienceConfig(storyId)) {
    if (onPhase) onPhase('Synthesizing reader experience');
    try {
      // When regenerating, reuse the stored objective for the chapter so the
      // regenerated text targets the same reader experience (and folds in the
      // experience findings from the prior analysis as extra guidance).
      const regenExperience = isRegen && regenerate.experience ? regenerate.experience : null;
      // When resuming, reuse the objective captured on the partial chapter so
      // the continuation targets the SAME emotional trajectory — do NOT
      // synthesize a fresh, unrelated objective simply because the request
      // resumed after a timeout.
      const resumeExperience = isResume
        ? { objective: resume.experienceObjective || resumeGen.experienceObjective || null }
        : null;
      if (regenExperience && regenExperience.objective) {
        experienceObjective = regenExperience.objective;
        experienceSynthesis = { synthesized: true, objective: experienceObjective, chapter1: chapterNumber <= 1, reused: true };
      } else if (resumeExperience && resumeExperience.objective) {
        experienceObjective = resumeExperience.objective;
        experienceSynthesis = { synthesized: true, objective: experienceObjective, chapter1: chapterNumber <= 1, reused: true };
      } else {
        experienceSynthesis = await experience.synthesizeObjective(storyId, chapterNumber, aiOptions);
        experienceObjective = experienceSynthesis.objective || null;
      }
    } catch (e) {
      console.warn('[story] Reader Experience synthesis failed:', e.message);
      experienceSynthesis = { synthesized: false, objective: null, error: e.message };
    }
  }

  const experienceObjectiveBlock = experienceObjective
    ? experience.buildChapterObjectiveBlock(experienceObjective)
    : '';

  // When regenerating, fold Reader Experience findings into the regen block as
  // an ADDITIONAL constraint (alongside coherence + custom instruction) — it
  // must never erase the coherence correction or the experience objective.
  const experienceRegenBlock = (isRegen && regenerate.experience && regenerate.experience.findings)
    ? [
        '',
        '═══════════════════════════════════════════════════════════════',
        'READER EXPERIENCE FEEDBACK (additional constraint)',
        '═══════════════════════════════════════════════════════════════',
        'The previous version of this chapter did not fully deliver the intended',
        'reader experience. Address the findings below in addition to the coherence',
        'fix and any custom instruction — do NOT drop the coherence correction.',
        '',
        `Findings: ${JSON.stringify(regenerate.experience.findings.observed || {})}`,
        regenerate.experience.findings.recommendation
          ? `Experience recommendation: ${regenerate.experience.findings.recommendation}`
          : '',
        (regenerate.experience.findings.issues || []).length
          ? `Issues: ${regenerate.experience.findings.issues.join('; ')}`
          : '',
        '═══════════════════════════════════════════════════════════════',
      ].filter(Boolean).join('\n')
    : '';

  const prompt = isResume
    ? _buildResumePrompt({
        chapterNumber,
        existingPartial,
        remainingWords: resumeBudget.remainingWords,
        remainingLengthPolicy: buildLengthPolicy(length, resumeBudget.remainingWords),
        speakerTagInstruction,
        title: storyData.title, genre: storyData.genre, tone: storyData.tone, outline: storyData.outline,
        storyLawBlock, canonicalNamesBlock, characterContext, loreContext, prior,
        experienceObjectiveBlock, customPrompt,
      })
    : [
        isRegen
          ? 'You are a creative writing assistant. Regenerate a chapter of a story to resolve a coherence issue.'
          : 'You are a creative writing assistant. Write a detailed, immersive chapter of a story.',
        'Respond with ONLY a valid JSON object containing exactly this field:',
        '  "content": the full chapter text as a single well-formatted string (prose paragraphs separated by blank lines)',
        '',
        lengthPolicy,
        '',
        'MANDATORY FORMATTING RULES — your chapter MUST follow these exactly:',
        '',
        '1. BLANK LINES BETWEEN PARAGRAPHS: Every paragraph MUST be separated by exactly one blank line (double newline).',
        '   A wall-of-text without paragraph breaks is a FAILURE and will be rejected.',
        '   Typical chapter has 8-15+ separate paragraphs.',
        '',
        '2. DIALOGUE VS NARRATION SEPARATION:',
        '   - Each dialogue line (character speech) MUST be in its own paragraph.',
        '   - Each narrative/description block MUST be in its own paragraph.',
        '   - Never combine multiple sentences of different types into one paragraph.',
        '',
        '3. REQUIRED SPEAKER/EMOTION TAGS:',
        '   Begin EVERY paragraph with a [speaker:X][emotion:Y] tag BEFORE any text.',
        '   speaker:X must be a character name (e.g. [speaker:Elena]) or "narrator"/"male"/"female" for generic narration.',
        '   emotion:Y must be one of: ' + EMOTION_PRESETS.map((e) => `[emotion:${e}]`).join(', ') + '.',
        '   For narrator paragraphs use ONLY [emotion:neutral] or [emotion:calm].',
        '   Tags are invisible to readers and used only by the audio system.',
        '',
        '4. FORBIDDEN — SINGLE WALL-OF-TEXT CHAPTER:',
        '   Chapters without paragraph breaks (single block of text) are NOT acceptable.',
        '   You MUST insert blank lines to create distinct paragraphs.',
        '',
        speakerTagInstruction,
        '',
        '5. CRITICAL — DIALOGUE AND ATTRIBUTION MUST BE SEPARATE PARAGRAPHS:',
        '   When a character speaks AND the sentence contains a narrative attribution (e.g. "she said", "he murmured"),',
        '   split them into SEPARATE paragraphs:',
        '   - First: [speaker:character][emotion:X] "Quoted speech only."',
        '   - Then: [speaker:narrator][emotion:neutral] Attribution and following narration.',
        '',
        'Correct examples:',
        '[speaker:female][emotion:curious] "I should look into this."',
        '[speaker:narrator][emotion:neutral] Alex murmured aloud, her voice barely audible over the rustling of papers.',
        '[speaker:male][emotion:happy] "We finally made it!"',
        '[speaker:narrator][emotion:neutral] Thomas shouted, punching the air.',
        '',
        'Wrong (do NOT do this):',
        '[speaker:female][emotion:curious] "I should look into this," Alex murmured aloud, her voice barely audible.',
        '',
        'Use ONLY the square-bracket format shown above. Do NOT use quotes around the tags.',
        '',
        `Title: ${storyData.title}`,
        `Genre: ${storyData.genre}`,
        `Tone: ${storyData.tone}`,
        `Outline:\n${storyData.outline}`,
        storyLawBlock ? `\n${storyLawBlock}` : '',
        canonicalNamesBlock ? `\n${canonicalNamesBlock}` : '',
        characterContext ? `\n${characterContext}` : '',
        loreContext ? `\n${loreContext}` : '',
        prior ? `\nPreviously written chapters:\n${prior}` : '',
        coherenceRegenBlock || '',
        experienceRegenBlock || '',
        experienceObjectiveBlock || '',
        customPrompt ? `\nAdditional instructions: ${customPrompt}` : '',
        isRegen
          ? `\nNow regenerate Chapter ${chapterNumber}. Make it complete, engaging, and rich in detail.`
          : `\nNow write Chapter ${chapterNumber}. Make it complete, engaging, and rich in detail.`,
      ].join('\n');

  // ── AI generation (with partial-content preservation on timeout) ──────────
  // On a streaming timeout / connection failure that already produced partial
  // text, ai.askStream rejects with an Error carrying `.partial` and `.reason`.
  // We preserve that partial as a "partial" chapter (no post-processing) so the
  // user can RESUME rather than lose the work. A timeout with no usable output
  // rethrows as a normal generation failure.
  let raw;
  if (isResume && !existingPartial.trim()) {
    throw new Error('Cannot resume: no existing partial chapter content was found.');
  }
  try {
    if (onPhase) onPhase(isResume ? 'Resuming chapter' : 'Writing chapter');
    raw = onToken
      ? await ai.askStream(prompt, askOptions, onToken)
      : await ai.ask(prompt, askOptions);
  } catch (e) {
    if (e && typeof e.partial === 'string' && ai.isMeaningfulPartial(e.partial)) {
      // Preserve the partial chapter on disk so it survives UI state changes,
      // but do NOT run summary / knowledge / coherence / experience analysis —
      // those run only against a completed chapter.
      const partialContent = parseChapterContent(e.partial);
      if (!ai.isMeaningfulPartial(partialContent)) {
        // The streamed text was too thin to count as a usable chapter draft.
        throw new Error('Generation timed out before usable chapter content was received.');
      }
      const reason = e.reason || 'timeout';
      const partialChapter = {
        number: chapterNumber,
        content: partialContent,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: {
          reason,
          length,
          wordTarget,
          model: aiOptions.model || resumeGen.model || undefined,
          experienceObjective: experienceObjective || undefined,
        },
      };
      if (!storyData.chapters) storyData.chapters = [];
      const pidx = storyData.chapters.findIndex((c) => c.number === chapterNumber);
      if (pidx >= 0) storyData.chapters[pidx] = partialChapter;
      else { storyData.chapters.push(partialChapter); storyData.chapters.sort((a, b) => a.number - b.number); }
      fs.writeFileSync(filepath, JSON.stringify(storyData, null, 2), 'utf8');

      if (onPhase) onPhase('Generation timed out — partial preserved');
      return {
        storyId,
        chapterNumber,
        content: partialContent,
        status: 'partial',
        reason,
        resumeAvailable: true,
        experienceObjective: experienceSynthesis ? {
          synthesized: experienceSynthesis.synthesized,
          chapter1: experienceSynthesis.chapter1,
          reused: experienceSynthesis.reused || false,
          objective: experienceObjective,
        } : null,
      };
    }
    // No partial content (or non-streaming ask) — surface a normal failure.
    if (/timed out/i.test(e.message)) {
      throw new Error('Generation timed out before usable chapter content was received.');
    }
    throw e;
  }

  // ── Assemble final content ────────────────────────────────────────────────
  let content;
  if (isResume) {
    const continuation = parseChapterContent(raw);
    // De-duplicate: if the model restated the tail of the existing text, strip it.
    const cleaned = stripContinuationOverlap(existingPartial, continuation);
    content = normalizeChapterParagraphs(normalizeText(
      (existingPartial.trimEnd() + '\n\n' + cleaned.trim()).trim()
    ));
  } else {
    content = parseChapterContent(raw);
  }
  const chapter = { number: chapterNumber, content, status: 'complete', createdAt: new Date().toISOString() };

  if (!storyData.chapters) storyData.chapters = [];
  const idx = storyData.chapters.findIndex((c) => c.number === chapterNumber);
  if (idx >= 0) {
    // Preserve original createdAt when replacing an existing (e.g. partial) chapter.
    const prev = storyData.chapters[idx];
    chapter.createdAt = (prev && prev.createdAt) || chapter.createdAt;
    storyData.chapters[idx] = chapter;
  } else {
    storyData.chapters.push(chapter);
    storyData.chapters.sort((a, b) => a.number - b.number);
  }

  fs.writeFileSync(filepath, JSON.stringify(storyData, null, 2), 'utf8');

  // Generate and store a summary of this chapter for future continuity context.
  if (onPhase) onPhase('Summarizing chapter');
  await _storeChapterSummary(storyId, chapterNumber, content, aiOptions);

  // Auto-create character profiles for any new named speakers in the chapter.
  if (onPhase) onPhase('Extracting characters');
  await _extractNewCharacters(storyId, content, aiOptions);

  // Auto-extract knowledge elements from the chapter (new places, systems, arc boundaries, etc.)
  if (onPhase) onPhase('Extracting world knowledge');
  await _extractChapterKnowledge(storyId, chapterNumber, content, aiOptions);

  // ── Localize newly discovered entities (Name & Place Localization) ────────
  // When localization is active, any entities the chapter introduced (new
  // characters / places / lore) that aren't already mapped receive a canonical
  // name in a SINGLE batched LLM call, so the model is never asked to rename the
  // same character every chapter. Soft-fails: a localization error never
  // blocks the chapter (already saved) and never changes existing mappings.
  if (localization.isActive(storyId)) {
    if (onPhase) onPhase('Localizing names');
    try {
      const afterChars = storyRag.listDocs(storyId, 'character') || [];
      const afterLore = storyRag.listDocs(storyId, 'lore') || [];
      const afterPlaces = storyRag.listDocs(storyId, 'place') || [];
      const newEntities = []
        .concat(afterChars.map((c) => ({ name: c.name, type: 'character' })))
        .concat(afterPlaces.map((p) => ({ name: p.title, type: 'place' })))
        .concat(afterLore.map((l) => ({ name: l.title, type: 'place' })))
        .filter((e) => e.name);
      await localization.localizeEntities(storyId, newEntities, aiOptions);
    } catch (e) {
      console.warn('[story] New-entity localization failed:', e.message);
    }
  }

  // Run coherence check on the generated chapter (soft gate - guide, don't freeze)
  if (onPhase) onPhase('Checking coherence');
  let coherenceResult = null;
  try {
    coherenceResult = await coherence.checkChapter(storyId, content, {
      checkCharacters: true,
      checkLore: true,
      checkCausality: true,
    }, aiOptions);
  } catch (e) {
    console.warn('[story] Coherence check failed:', e.message);
    // Don't fail the chapter generation if coherence check fails
  }

  // Reader Experience post-generation analysis (soft, opt-in). Never blocks
  // the chapter from being saved; on failure the previous state is preserved
  // and a failure note is surfaced alongside the coherence result.
  let experienceResult = null;
  if (experienceObjective) {
    if (onPhase) onPhase('Analyzing reader experience');
    try {
      const analysis = await experience.analyzeChapter(storyId, chapterNumber, content, experienceObjective, aiOptions);
      experienceResult = analysis.analyzed
        ? analysis.findings
        : { analyzed: false, error: analysis.error };
    } catch (e) {
      console.warn('[story] Reader Experience analysis failed:', e.message);
      experienceResult = { analyzed: false, error: e.message };
    }
  }

  if (onPhase) onPhase('Done');
  return {
    storyId,
    chapterNumber,
    content,
    status: 'complete',
    coherence: coherenceResult,
    experience: experienceResult,
    experienceObjective: experienceSynthesis ? {
      synthesized: experienceSynthesis.synthesized,
      chapter1: experienceSynthesis.chapter1,
      reused: experienceSynthesis.reused || false,
      objective: experienceObjective,
    } : null,
  };
}

/**
 * Extract the chapter content string from the AI response.
 * Falls back to the raw response text if JSON parsing fails.
 * Applies normalizeChapterParagraphs to ensure proper paragraph structure.
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
        return normalizeChapterParagraphs(normalizeText(parsed.content.trim()));
      }
    } catch { /* try next */ }
    // Attempt 2: escape unescaped literal newlines inside JSON string values
    // (a common pattern for AI models that don't strictly format JSON)
    try {
      const fixed = jsonStr.replace(/\r?\n/g, '\\n');
      const parsed = JSON.parse(fixed);
      if (typeof parsed.content === 'string' && parsed.content.trim()) {
        return normalizeChapterParagraphs(normalizeText(parsed.content.trim()));
      }
    } catch { /* fall through */ }
  }
  return normalizeChapterParagraphs(normalizeText(raw.trim()));
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

module.exports = { create, generateChapter, updateChapterContent, deleteChapter, deleteStory, list, get, pickVoicePreset, normalizeChapterParagraphs, buildLengthPolicy, chapterTokenBudget, CHAPTER_LENGTH_PRESETS, wordCount, resumeTokenBudget, stripContinuationOverlap };

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

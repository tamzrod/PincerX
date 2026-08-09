'use strict';

/**
 * Reader Experience / Emotional Trajectory synthesis layer.
 *
 * =============================================================================
 * PURPOSE
 * =============================================================================
 * Help produce serialized stories that keep listeners emotionally engaged and
 * curious rather than individually plausible but dull or incoherent chapters.
 *
 * Flow:
 *   AUTHOR INTENT (Reader Experience config)
 *     → ENGINE / STORY ANALYSIS (this module)
 *     → READER EXPERIENCE SYNTHESIS (structured chapter objective)
 *     → CHAPTER NARRATIVE OBJECTIVE (compact prompt block)
 *     → LLM GENERATION (story.js)
 *     → CHAPTER
 *     → READER EXPERIENCE ANALYSIS (did the chapter deliver the experience?)
 *     → COHERENCE ANALYSIS (story-coherence.js — kept separate)
 *     → RECOMMENDATION
 *     → REGENERATION
 *
 * =============================================================================
 * RELATIONSHIP TO EXISTING ARCHITECTURE
 * =============================================================================
 * This is a LIGHTWEIGHT synthesis layer. It does NOT create a new KDE engine
 * and does NOT duplicate Beta (KDE-ENGINE-002) or Gamma (KDE-ENGINE-003),
 * which live in story-coherence.js. It reuses:
 *   - the typed RAG store (story-rag.js) for evolving state
 *   - lib/ai.js for LLM calls
 *   - story.js chapter summaries for pattern/trajectory analysis
 *
 * Coherence asks: "Does this chapter make sense given what's established?"
 * Reader Experience asks: "Does this chapter produce the intended experience?"
 * A chapter may be Coherent: PASS and Reader Experience: NEEDS IMPROVEMENT.
 * The two subsystems are intentionally separate; this module never blocks
 * chapter saving (soft-fail everywhere).
 * =============================================================================
 */

const ai = require('../lib/ai');
const storyRag = require('./story-rag');

/**
 * Experience categories the author can prioritise (author intent, NOT the
 * detailed writing-rule list — strategies are derived dynamically).
 *
 * Values are stable machine-readable identifiers (snake_case). The matching
 * human-readable labels (for the UI + LLM prompt) live in CATEGORY_LABELS.
 */
const EXPERIENCE_CATEGORIES = [
  'curiosity',
  'suspense',
  'tension',
  'mystery',
  'emotional_investment',
  'wonder',
  'humor',
  'excitement',
  'romance',
  'triumph',
];

const INTENSITY_LEVELS = ['low', 'moderate', 'high'];
const PACING_LEVELS = ['slow', 'moderate', 'fast'];

/**
 * Machine value → display label. The UI dropdowns use these as their option
 * text (the option *value* stays the machine id), and the synthesis prompt
 * uses these so the LLM reads natural-language intent.
 */
const CATEGORY_LABELS = {
  curiosity: 'Curiosity',
  suspense: 'Suspense',
  tension: 'Tension',
  mystery: 'Mystery',
  emotional_investment: 'Emotional Investment',
  wonder: 'Wonder',
  humor: 'Humor',
  excitement: 'Excitement',
  romance: 'Romance',
  triumph: 'Triumph',
};

const INTENSITY_LABELS = { low: 'Low', moderate: 'Moderate', high: 'High' };
const PACING_LABELS = { slow: 'Slow', moderate: 'Moderate', fast: 'Fast' };

/** Resolve any machine value or display label to its canonical machine id. */
function _canonicalizeCategory(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (EXPERIENCE_CATEGORIES.includes(v)) return v;
  // Accept the display label (e.g. "Emotional Investment") as a courtesy at
  // the API boundary so a client sending labels is still normalised.
  for (const id of EXPERIENCE_CATEGORIES) {
    if (CATEGORY_LABELS[id].toLowerCase() === v) return id;
  }
  return null;
}

function _canonicalizeLevel(value, allowed, labels) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (allowed.includes(v)) return v;
  for (const id of allowed) {
    if (labels[id].toLowerCase() === v) return id;
  }
  return null;
}

function _categoryLabel(id) {
  return CATEGORY_LABELS[id] || id;
}

function _intensityLabel(id) {
  return INTENSITY_LABELS[id] || id;
}

function _pacingLabel(id) {
  return PACING_LABELS[id] || id;
}

/**
 * Default config used by the API/UI as placeholder values. A story only
 * activates Reader Experience synthesis once a config is actually stored in
 * its RAG state (see story-rag.js#getExperienceConfig), so stories that
 * pre-date the feature keep the original generation behaviour unchanged.
 */
const DEFAULT_CONFIG = {
  primary: 'curiosity',
  secondary: 'suspense',
  intensity: 'moderate',
  pacing: 'moderate',
};

/**
 * Dimensions tracked in reader state (0–100).
 */
const STATE_DIMENSIONS = [
  'curiosity',
  'tension',
  'emotionalInvestment',
  'mystery',
  'anticipation',
];

/**
 * Keyword families used by the deterministic repetition detector. When the
 * same family dominates several recent chapter summaries, the synthesis layer
 * is nudged to recommend variation. This is intentionally heuristic — it only
 * flags monotony, never forces variation for its own sake.
 */
const REPETITION_FAMILIES = [
  { name: 'protagonist_wins', keywords: ['defeated', 'won', 'triumphed', 'prevailed', 'succeeded', 'conquered', 'overcame'] },
  { name: 'humiliation', keywords: ['humiliated', 'shamed', 'embarrassed', 'degraded'] },
  { name: 'rescue', keywords: ['rescued', 'saved', 'bailed out', 'delivered'] },
  { name: 'loss', keywords: ['lost', 'failed', 'fell', 'retreated', 'fled'] },
  { name: 'reveal', keywords: ['revealed', 'uncovered', 'discovered', 'exposed'] },
];

/** Minimum recent-chapter window before repetition is considered. */
const REPETITION_MIN_WINDOW = 3;

/**
 * Validate a Reader Experience config object.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[], normalized: object|null }}
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object.'], normalized: null };
  }

  const primary = _canonicalizeCategory(config.primary);
  const secondary = _canonicalizeCategory(config.secondary);
  const intensity = _canonicalizeLevel(config.intensity, INTENSITY_LEVELS, INTENSITY_LABELS);
  const pacing = _canonicalizeLevel(config.pacing, PACING_LEVELS, PACING_LABELS);

  const categoryList = EXPERIENCE_CATEGORIES.map(_categoryLabel).join(', ');
  if (!primary) errors.push(`Invalid primary category. Must be one of: ${categoryList}.`);
  if (!secondary) errors.push(`Invalid secondary category. Must be one of: ${categoryList}.`);
  if (!intensity) errors.push(`Invalid intensity. Must be one of: ${INTENSITY_LEVELS.map(_intensityLabel).join(', ')}.`);
  if (!pacing) errors.push(`Invalid pacing. Must be one of: ${PACING_LEVELS.map(_pacingLabel).join(', ')}.`);

  if (primary && secondary && primary === secondary) {
    errors.push('Secondary category must differ from primary.');
  }

  if (errors.length > 0) {
    return { valid: false, errors, normalized: null };
  }

  return {
    valid: true,
    errors: [],
    normalized: { primary, secondary, intensity, pacing },
  };
}

/**
 * Heuristic repetition detector. Scans recent chapter summaries for repeated
 * emotional/structural patterns (e.g. "humiliation → protagonist wins" across
 * many chapters) and returns evidence the synthesis layer can use to recommend
 * variation. Purely deterministic — no LLM call.
 *
 * @param {string} storyId
 * @param {number} [window] - Number of recent summaries to inspect (default 6).
 * @returns {{ detected: boolean, pattern: string|null, evidence: string[], count: number, suggestion: string|null }}
 */
function detectRepetition(storyId, window = 6) {
  const summaries = (storyRag.listDocs(storyId, 'summary') || [])
    .filter((d) => typeof d.chapterNumber === 'number')
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .slice(-window);

  const evidence = [];
  const counts = {};
  for (const s of summaries) {
    const text = (s.content || '').toLowerCase();
    for (const family of REPETITION_FAMILIES) {
      if (family.keywords.some((k) => text.includes(k))) {
        counts[family.name] = (counts[family.name] || 0) + 1;
        evidence.push(`Ch${s.chapterNumber}: ${family.name}`);
      }
    }
  }

  let dominant = null;
  let dominantCount = 0;
  for (const [name, count] of Object.entries(counts)) {
    if (count > dominantCount) {
      dominant = name;
      dominantCount = count;
    }
  }

  const detected = dominant !== null && dominantCount >= REPETITION_MIN_WINDOW;
  return {
    detected,
    pattern: detected ? dominant : null,
    evidence,
    count: dominantCount,
    suggestion: detected ? _variationSuggestion(dominant) : null,
  };
}

function _variationSuggestion(pattern) {
  const map = {
    protagonist_wins: 'Vary the outcome: the protagonist could lose, a secondary character could resolve the problem, or an apparent victory could create a larger problem.',
    humiliation: 'Vary the emotional beat: replace another humiliation with a strategic retreat, a quiet dignity, or an antagonist who predicts the protagonist.',
    rescue: 'Vary the rescue pattern: delay the rescue, have the rescue come at a cost, or let the protagonist self-rescue imperfectly.',
    loss: 'Vary repeated losses: offer a partial hope, a pyrrhic gain, or a shift in what "winning" means.',
    reveal: 'Vary repeated reveals: withhold longer, foreshadow instead of reveal, or reveal something that deepens rather than resolves the mystery.',
  };
  return map[pattern] || 'Vary the recurring emotional pattern to avoid monotony.';
}

/**
 * Synthesise a structured Reader Experience objective for a chapter.
 *
 * Soft-fail: if the LLM is unreachable, returns { synthesized: false, error }
 * and never throws. The previous Reader Experience state is preserved (the
 * caller decides whether to fall back to a default compact objective).
 *
 * @param {string} storyId
 * @param {number} chapterNumber
 * @param {object} [aiOptions] - Forwarded to ai.ask (model is respected).
 * @returns {Promise<{ synthesized: boolean, objective: object|null, chapter1: boolean, error?: string, repetition?: object }>}
 */
async function synthesizeObjective(storyId, chapterNumber, aiOptions = {}) {
  const chapter1 = chapterNumber <= 1;
  const config = storyRag.getExperienceConfig(storyId);
  if (!config) {
    // No author intent configured → feature inactive for this story.
    return { synthesized: false, objective: null, chapter1, error: 'No Reader Experience config set.' };
  }

  const prevState = storyRag.getExperienceState(storyId) || {};
  const currentState = prevState.currentState || _emptyState();
  const readerQuestions = prevState.readerQuestions || [];
  const knowledgeManagement = prevState.knowledgeManagement || { reveal: [], withhold: [], foreshadow: [] };
  const trajectory = prevState.trajectory || [];

  const repetition = detectRepetition(storyId);

  // Story context for the synthesis prompt.
  const summaries = (storyRag.listDocs(storyId, 'summary') || [])
    .filter((d) => typeof d.chapterNumber === 'number' && d.chapterNumber < chapterNumber)
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .slice(-6)
    .map((d) => `Ch${d.chapterNumber}: ${d.content}`)
    .join('\n');

  const characters = (storyRag.listDocs(storyId, 'character') || [])
    .slice(0, 8)
    .map((c) => `${c.name}${c.role ? ` (${c.role})` : ''}`)
    .join(', ');

  const prompt = _buildSynthesisPrompt({
    chapterNumber,
    chapter1,
    config,
    currentState,
    readerQuestions,
    knowledgeManagement,
    trajectory,
    repetition,
    summaries,
    characters,
  });

  // Synthesis uses ai.ask (non-streaming). Strip streaming-only hooks; keep
  // model + provider + apiKey so the UI-selected model is honoured.
  const synOptions = _cleanAiOptions(aiOptions);

  let raw;
  try {
    raw = await ai.ask(prompt, synOptions);
  } catch (e) {
    return { synthesized: false, objective: null, chapter1, error: e.message, repetition };
  }

  const objective = parseSynthesisResponse(raw);
  if (!objective) {
    return { synthesized: false, objective: null, chapter1, error: 'Failed to parse synthesis response.', repetition };
  }

  // Stamp metadata so downstream consumers (analysis, regeneration, UI) know
  // the objective's provenance without re-deriving it.
  objective.chapterNumber = chapterNumber;
  objective.chapter1 = chapter1;
  objective.config = config;

  return { synthesized: true, objective, chapter1, repetition };
}

/**
 * Build the LLM prompt for synthesis. Kept separate so it can be unit-tested
 * for Chapter 1 special framing.
 */
function _buildSynthesisPrompt(ctx) {
  const {
    chapterNumber, chapter1, config, currentState, readerQuestions,
    knowledgeManagement, trajectory, repetition, summaries, characters,
  } = ctx;

  const base = [
    'You are a narrative strategist for a serialized story.',
    'Analyse the story state and derive a structured READER EXPERIENCE OBJECTIVE for the chapter.',
    'Do NOT produce a static writing-rule list. Derive strategies dynamically from the story state,',
    'existing chapters, reader knowledge vs character knowledge, unresolved questions, and the',
    'emotional trajectory so far.',
    '',
    `Author intent (Reader Experience config):`,
    `  Primary: ${_categoryLabel(config.primary)} (${config.primary})`,
    `  Secondary: ${_categoryLabel(config.secondary)} (${config.secondary})`,
    `  Emotional intensity: ${_intensityLabel(config.intensity)} (${config.intensity})`,
    `  Pacing: ${_pacingLabel(config.pacing)} (${config.pacing})`,
    '',
    'How to interpret this author intent:',
    `  - Primary (${_categoryLabel(config.primary)}) is the DOMINANT experience the listener should have.`,
    '    Decide HOW to create it from the actual story state — do NOT apply a fixed recipe.',
    `  - Secondary (${_categoryLabel(config.secondary)}) is a SUPPORTING experience. Use it for contrast`,
    '    or relief when appropriate; it must NOT dominate or appear in every scene, and must NOT',
    '    contradict the primary experience.',
    `  - Intensity (${_intensityLabel(config.intensity)}) controls how strongly the primary experience`,
    '    drives THIS chapter. "high" = a major driver, not "make everything extreme";',
    '    "low" = a subtle influence; "moderate" = clearly noticeable but balanced.',
    `  - Pacing (${_pacingLabel(config.pacing)}) controls how quickly the experience changes, NOT sentence`,
    '    length. "slow" = let atmosphere, interaction, discovery and emotion develop;',
    '    "moderate" = balanced progression; "fast" = shorter beats, quicker escalation,',
    '    more frequent shifts in situation.',
    'Do NOT reduce the intent to a shallow instruction like "make it curious and suspenseful".',
    'Derive concrete, story-specific narrative objectives from the current state below.',
    '',
    `Current reader state (0-100): ${JSON.stringify(currentState)}`,
    `Open reader questions: ${JSON.stringify(readerQuestions)}`,
    `Knowledge management: ${JSON.stringify(knowledgeManagement)}`,
    `Recent emotional trajectory: ${JSON.stringify(trajectory)}`,
    repetition && repetition.detected
      ? `Detected repetition: pattern "${repetition.pattern}" occurred ${repetition.count} times. Consider variation: ${repetition.suggestion}`
      : 'No monotonic repetition detected.',
    '',
    `Recent chapters:`,
    summaries || '(none yet)',
    '',
    `Characters: ${characters || '(none yet)'}`,
    '',
  ];

  if (chapter1) {
    base.push(
      'CHAPTER 1 IS SPECIAL — the listener has no emotional investment, no story knowledge,',
      'and no attachment to characters. Optimise this chapter for ACQUISITION:',
      '  - immediate engagement',
      '  - curiosity',
      '  - emotional investment',
      '  - a clear story promise',
      '  - forward momentum',
      '  - a compelling unresolved question',
      '  - strong anticipation for Chapter 2',
      'Do NOT require a fixed opening structure. Decide what kind of opening best serves THIS story.',
      'Avoid excessive exposition. The chapter must answer: "Why should a new listener continue listening?"',
      '',
    );
  } else {
    base.push(
      `This is Chapter ${chapterNumber}. Optimise for RETENTION rather than acquisition:`,
      '  - sustain curiosity and tension',
      '  - progress emotional investment',
      '  - manage what the reader knows vs what characters know',
      '  - avoid resolving mysteries too early',
      '  - create anticipation for the next chapter',
      '',
    );
  }

  base.push(
    'Respond with ONLY a valid JSON object with exactly these fields:',
    '{',
    '  "currentState": { "curiosity": N, "tension": N, "emotionalInvestment": N, "mystery": N, "anticipation": N },',
    '  "targetState":  { "curiosity": N, "tension": N, "emotionalInvestment": N, "mystery": N, "anticipation": N },',
    '  "readerQuestions": ["open question 1", "open question 2"],',
    '  "knowledgeManagement": {',
    '    "reveal":     ["what the reader should learn this chapter"],',
    '    "withhold":   ["what must NOT be revealed yet"],',
    '    "foreshadow": ["subtle hints to plant for later"]',
    '  },',
    '  "narrativeObjectives": ["compact, story-specific objective 1", "..."],',
    '  "emotionalTrajectory": ["calm", "curiosity", "unease"],',
    '  "readerShouldDiscover": ["concrete thing the reader realises this chapter"],',
    '  "readerShouldNotDiscover": ["concrete thing kept hidden this chapter"],',
    '  "characterObjective": "what the POV/protagonist must do/protect this chapter",',
    '  "endingState": "the reader emotional/informational state at chapter end",',
    '  "nextChapterPull": "the single question that pulls the reader into the next chapter"',
    '}',
    'All state values are integers 0-100. Keep narrativeObjectives compact and story-specific.',
  );

  return base.join('\n');
}

/**
 * Parse the LLM synthesis response into a structured objective. Tolerates
 * prose around the JSON and literal newlines inside string values (mirrors
 * the coherence parser's resilience).
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseSynthesisResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    try {
      parsed = JSON.parse(match[0].replace(/\r?\n/g, '\\n'));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  // Normalise the shape so downstream code can rely on the fields existing.
  const objective = {
    currentState: _clampState(parsed.currentState),
    targetState: _clampState(parsed.targetState),
    readerQuestions: _toStringArray(parsed.readerQuestions),
    knowledgeManagement: {
      reveal: _toStringArray(parsed.knowledgeManagement && parsed.knowledgeManagement.reveal),
      withhold: _toStringArray(parsed.knowledgeManagement && parsed.knowledgeManagement.withhold),
      foreshadow: _toStringArray(parsed.knowledgeManagement && parsed.knowledgeManagement.foreshadow),
    },
    narrativeObjectives: _toStringArray(parsed.narrativeObjectives),
    emotionalTrajectory: _toStringArray(parsed.emotionalTrajectory),
    readerShouldDiscover: _toStringArray(parsed.readerShouldDiscover),
    readerShouldNotDiscover: _toStringArray(parsed.readerShouldNotDiscover),
    characterObjective: typeof parsed.characterObjective === 'string' ? parsed.characterObjective.trim() : '',
    endingState: typeof parsed.endingState === 'string' ? parsed.endingState.trim() : '',
    nextChapterPull: typeof parsed.nextChapterPull === 'string' ? parsed.nextChapterPull.trim() : '',
  };

  return objective;
}

function _clampState(state) {
  if (!state || typeof state !== 'object') return {};
  const out = {};
  for (const dim of STATE_DIMENSIONS) {
    const v = state[dim];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[dim] = Math.max(0, Math.min(100, Math.round(v)));
    }
  }
  return out;
}

function _toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
}

/**
 * Build a COMPACT chapter-objective block for injection into the generation
 * prompt. Deliberately does NOT dump the entire internal synthesis state —
 * only what the writer-model needs to produce the intended experience.
 *
 * @param {object} objective
 * @returns {string}
 */
function buildChapterObjectiveBlock(objective) {
  if (!objective) return '';

  const lines = [
    '',
    '═══════════════════════════════════════════════════════════════',
    objective.chapter1 ? 'READER EXPERIENCE OBJECTIVE — CHAPTER 1 (ACQUISITION)' : 'READER EXPERIENCE OBJECTIVE',
    '═══════════════════════════════════════════════════════════════',
  ];

  if (objective.chapter1) {
    lines.push(
      'This is the listener\'s first chapter. They have no investment yet.',
      'Prioritise immediate engagement, curiosity, a clear story promise,',
      'forward momentum, and a strong reason to continue to Chapter 2.',
      'Avoid excessive exposition.',
    );
  }

  const cs = objective.currentState || {};
  const ts = objective.targetState || {};
  if (Object.keys(cs).length || Object.keys(ts).length) {
    lines.push(
      `Reader starting state: ${_stateLine(cs) || 'comfortable but curious'}.`,
      `Desired movement: ${_stateMovement(cs, ts) || 'increase engagement and curiosity'}.`,
    );
  }

  if (objective.emotionalTrajectory && objective.emotionalTrajectory.length) {
    lines.push(`Emotional trajectory: ${objective.emotionalTrajectory.join(' → ')}.`);
  }

  if (objective.narrativeObjectives && objective.narrativeObjectives.length) {
    lines.push('Narrative purpose:');
    for (const o of objective.narrativeObjectives) lines.push(`  - ${o}`);
  }

  if (objective.readerShouldDiscover && objective.readerShouldDiscover.length) {
    lines.push(`Reader should discover: ${objective.readerShouldDiscover.join('; ')}.`);
  }
  if (objective.readerShouldNotDiscover && objective.readerShouldNotDiscover.length) {
    lines.push(`Reader should NOT discover: ${objective.readerShouldNotDiscover.join('; ')}.`);
  }
  if (objective.characterObjective) {
    lines.push(`Character objective: ${objective.characterObjective}`);
  }
  if (objective.endingState) {
    lines.push(`Ending state: ${objective.endingState}`);
  }
  if (objective.nextChapterPull) {
    lines.push(`Next-chapter pull: ${objective.nextChapterPull}`);
  }

  lines.push(
    'Manage reader knowledge vs character knowledge carefully: do not resolve',
    'a mystery just because the information is available — withhold per the',
    'objective above. Honour the author intent while keeping the chapter vivid.',
    '═══════════════════════════════════════════════════════════════',
  );

  return lines.join('\n');
}

function _stateLine(state) {
  if (!state) return '';
  const parts = [];
  for (const dim of STATE_DIMENSIONS) {
    if (typeof state[dim] === 'number') parts.push(`${dim}=${state[dim]}`);
  }
  return parts.join(', ');
}

function _stateMovement(from, to) {
  if (!from || !to) return '';
  const parts = [];
  for (const dim of STATE_DIMENSIONS) {
    if (typeof from[dim] === 'number' && typeof to[dim] === 'number') {
      const delta = to[dim] - from[dim];
      if (delta !== 0) parts.push(`${dim} ${delta > 0 ? '↑' : '↓'}${Math.abs(delta)}`);
    }
  }
  return parts.join(', ');
}

/**
 * Analyse a generated chapter against its Reader Experience objective.
 *
 * Soft-fail: on LLM failure returns { analyzed: false, error } and never
 * throws. The chapter is NEVER blocked from saving by this subsystem.
 *
 * On success, evolves the stored Reader Experience state (currentState,
 * readerQuestions, trajectory) so the next chapter's synthesis builds on it.
 *
 * @param {string} storyId
 * @param {number} chapterNumber
 * @param {string} content - The generated chapter text.
 * @param {object} objective - The objective produced by synthesizeObjective.
 * @param {object} [aiOptions] - Forwarded to ai.ask (model is respected).
 * @returns {Promise<{ analyzed: boolean, findings: object|null, error?: string }>}
 */
async function analyzeChapter(storyId, chapterNumber, content, objective, aiOptions = {}) {
  if (!objective) {
    return { analyzed: false, findings: null, error: 'No objective provided for analysis.' };
  }

  const prevState = storyRag.getExperienceState(storyId) || {};
  const recentTrajectory = (prevState.trajectory || []).slice(-4);

  const prompt = [
    'You are evaluating whether a chapter delivered its intended READER EXPERIENCE.',
    'Compare the actual chapter against the objective. This is a SOFT evaluation —',
    'it never blocks the chapter from being saved; it only guides future generation.',
    '',
    'Objective:',
    JSON.stringify(objective, null, 2),
    '',
    'Recent emotional trajectory:',
    JSON.stringify(recentTrajectory),
    '',
    `Chapter ${chapterNumber} (excerpt, first 3000 chars):`,
    (content || '').slice(0, 3000),
    '',
    'Respond with ONLY a valid JSON object:',
    '{',
    '  "passed": true|false,',
    '  "observed": { "dimension": "increased"|"decreased"|"unchanged"|"revealed too early"|string },',
    '  "issues": ["specific issue 1"],',
    '  "recommendation": "one concise sentence guiding the next regeneration or chapter",',
    '  "newReaderState": { "curiosity": N, "tension": N, "emotionalInvestment": N, "mystery": N, "anticipation": N },',
    '  "resolvedQuestions": ["question the chapter answered"],',
    '  "newQuestions": ["new open question the chapter raised"]',
    '}',
    chapterNumber <= 1
      ? 'For Chapter 1, also weigh: opening engagement, orientation without excessive exposition, story promise, unresolved curiosity, and Chapter 2 anticipation.'
      : 'For later chapters, weigh retention: sustained curiosity/tension, mystery not resolved too early, and next-chapter anticipation.',
  ].join('\n');

  const analysisOptions = _cleanAiOptions(aiOptions);

  let raw;
  try {
    raw = await ai.ask(prompt, analysisOptions);
  } catch (e) {
    return { analyzed: false, findings: null, error: e.message };
  }

  const findings = parseAnalysisResponse(raw);
  if (!findings) {
    return { analyzed: false, findings: null, error: 'Failed to parse analysis response.' };
  }

  findings.chapterNumber = chapterNumber;

  // Evolve the stored Reader Experience state so synthesis stays current.
  // State evolution is best-effort: a parse failure here does not invalidate
  // the findings already returned.
  try {
    _evolveState(storyId, chapterNumber, objective, findings);
  } catch (e) {
    // State persistence failed — findings are still valid to surface.
    console.warn('[story-experience] State evolution failed:', e.message);
  }

  return { analyzed: true, findings };
}

/**
 * Parse the LLM analysis response. Tolerant of surrounding prose / bad JSON.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function parseAnalysisResponse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    try {
      parsed = JSON.parse(match[0].replace(/\r?\n/g, '\\n'));
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const observed = {};
  if (parsed.observed && typeof parsed.observed === 'object') {
    for (const [k, v] of Object.entries(parsed.observed)) {
      observed[k] = typeof v === 'string' ? v.trim() : String(v);
    }
  }

  return {
    passed: Boolean(parsed.passed),
    observed,
    issues: _toStringArray(parsed.issues),
    recommendation: typeof parsed.recommendation === 'string' ? parsed.recommendation.trim() : '',
    newReaderState: _clampState(parsed.newReaderState),
    resolvedQuestions: _toStringArray(parsed.resolvedQuestions),
    newQuestions: _toStringArray(parsed.newQuestions),
  };
}

/**
 * Evolve the stored Reader Experience state after a successful analysis:
 * update currentState, rotate reader questions, and append the trajectory.
 * Best-effort; never throws to the caller.
 */
function _evolveState(storyId, chapterNumber, objective, findings) {
  const state = storyRag.getExperienceState(storyId) || {};

  const currentState = (findings.newReaderState && Object.keys(findings.newReaderState).length)
    ? findings.newReaderState
    : (objective.targetState && Object.keys(objective.targetState).length
      ? objective.targetState
      : state.currentState || _emptyState());

  const prevQuestions = Array.isArray(state.readerQuestions) ? state.readerQuestions : [];
  const resolved = new Set((findings.resolvedQuestions || []).map((q) => q.toLowerCase()));
  const openQuestions = prevQuestions
    .filter((q) => !resolved.has(String(q).toLowerCase()))
    .concat(findings.newQuestions || []);

  const trajectory = Array.isArray(state.trajectory) ? state.trajectory.slice(-9) : [];
  if (objective.emotionalTrajectory && objective.emotionalTrajectory.length) {
    trajectory.push({
      chapterNumber,
      movement: objective.emotionalTrajectory.join(' → '),
      passed: findings.passed,
    });
  }

  storyRag.saveExperienceState(storyId, {
    config: state.config || objective.config,
    currentState,
    readerQuestions: openQuestions.slice(0, 12),
    knowledgeManagement: objective.knowledgeManagement || state.knowledgeManagement,
    trajectory,
    lastChapterNumber: chapterNumber,
    lastObjective: objective,
    lastFindings: findings,
  });
}

function _emptyState() {
  return { curiosity: 0, tension: 0, emotionalInvestment: 0, mystery: 0, anticipation: 0 };
}

/**
 * Strip streaming-only / generation-only options so synthesis/analysis AI
 * calls inherit model + auth + provider but not onPhase/onToken/maxTokens
 * (which are chapter-generation-specific).
 */
function _cleanAiOptions(aiOptions) {
  if (!aiOptions || typeof aiOptions !== 'object') return {};
  const out = {};
  for (const key of ['model', 'provider', 'apiKey', 'baseUrl', 'timeoutMs']) {
    if (aiOptions[key] !== undefined) out[key] = aiOptions[key];
  }
  return out;
}

module.exports = {
  synthesizeObjective,
  analyzeChapter,
  detectRepetition,
  validateConfig,
  parseSynthesisResponse,
  parseAnalysisResponse,
  buildChapterObjectiveBlock,
  EXPERIENCE_CATEGORIES,
  INTENSITY_LEVELS,
  PACING_LEVELS,
  CATEGORY_LABELS,
  INTENSITY_LABELS,
  PACING_LABELS,
  STATE_DIMENSIONS,
  DEFAULT_CONFIG,
};

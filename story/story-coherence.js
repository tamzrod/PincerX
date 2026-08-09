'use strict';

/**
 * Story Coherence Engine
 * 
 * =============================================================================
 * PROVENANCE: This module adapts concepts from KDE engines
 * Source: https://github.com/tamzrod/kde
 * 
 * KDE-ENGINE-002 (Beta) concepts:
 *   - Context Detection: Conditions under which a story element is valid
 *   - Boundary Detection: When a rule/trait stops being true
 *   - Confidence & Evidence: Attached to every coherence check
 * 
 * KDE-ENGINE-003 (Gamma) concepts:
 *   - Causal Mechanism: How events connect through motivation and consequence
 *   - Intervention Thinking: "What if" analysis grounded in story rules
 * =============================================================================
 * 
 * This lightweight layer validates narrative consistency for creative storytelling.
 * It asks the core KDE-style questions:
 *   - Beta: "Under what conditions is this true? When does it stop being true?"
 *   - Gamma: "How does X cause Y? What happens if we change X?"
 * 
 * @see docs/KDE-INHERITANCE.md for detailed mapping
 */

const ai = require('../lib/ai');
const storyRag = require('./story-rag');
const localization = require('./story-localization');

/** Confidence thresholds */
const CONFIDENCE_HIGH = 0.8;
const CONFIDENCE_MEDIUM = 0.5;
const CONFIDENCE_LOW = 0.3;

/** Generic speaker names that are never real characters */
const GENERIC_SPEAKERS = new Set(['narrator', 'male', 'female']);

/**
 * Result object for coherence checks
 * @typedef {Object} CoherenceResult
 * @property {boolean} isConsistent - Whether the element is consistent with established rules
 * @property {number} confidence - Confidence score 0-1
 * @property {string} level - 'high', 'medium', or 'low'
 * @property {string[]} warnings - List of potential issues
 * @property {string[]} suggestions - How to address issues
 * @property {string} evidence - Brief explanation of the check (KDE-ENGINE-002 Beta: Evidence)
 * @property {string[]} boundaries - Explicit boundary conditions (KDE-ENGINE-002 Beta: Boundary Detection)
 * @property {string} mechanism - Causal mechanism explanation (KDE-ENGINE-003 Gamma: Causal Mechanism)
 */

/**
 * Causal mechanism result object
 * @typedef {Object} CausalMechanism
 * @property {string} chain - The causal chain connecting events
 * @property {string} motivation - Character motivation driving the cause
 * @property {string} consequence - What this cause sets up next
 * @property {string[]} gaps - Missing causal links or logical jumps
 */

/**
 * Check a chapter for coherence with established story elements.
 * Validates character consistency, lore adherence, and causal logic.
 * 
 * @param {string} storyId - The story ID
 * @param {string} chapterContent - The chapter content to check
 * @param {Object} options - Check options
 * @param {boolean} options.checkCharacters - Check character consistency (default: true)
 * @param {boolean} options.checkLore - Check world/lore adherence (default: true)
 * @param {boolean} options.checkCausality - Check cause-effect logic (default: true)
 * @param {Object} aiOptions - AI transport options
 * @returns {Promise<CoherenceResult>}
 */
async function checkChapter(storyId, chapterContent, options = {}, aiOptions = {}) {
  const opts = {
    checkCharacters: true,
    checkLore: true,
    checkCausality: true,
    ...options
  };

  const warnings = [];
  const suggestions = [];
  const boundaries = [];
  let confidence = 1.0;
  let mechanism = '';
  let evidenceParts = [];

  // Gather story context
  const characters = storyRag.listDocs(storyId, 'character');
  const lore = storyRag.listDocs(storyId, 'lore');
  const summaries = storyRag.listDocs(storyId, 'summary');

  // 1. Character Consistency Check (KDE-ENGINE-002 Beta: Context + Boundary Detection)
  if (opts.checkCharacters && characters.length > 0) {
    const charResult = await checkCharacterConsistency(storyId, chapterContent, characters, aiOptions);
    if (!charResult.isConsistent) {
      warnings.push(...charResult.warnings);
      suggestions.push(...charResult.suggestions);
      confidence *= charResult.confidence;
      evidenceParts.push(`Characters: ${charResult.evidence}`);
    }
    // Aggregate boundaries from character check
    if (charResult.boundaries) {
      boundaries.push(...charResult.boundaries);
    }
  }

  // 2. Lore/World Rules Check (KDE-ENGINE-002 Beta: Context + Boundary Detection)
  if (opts.checkLore && lore.length > 0) {
    const loreResult = await checkLoreConsistency(storyId, chapterContent, lore, aiOptions);
    if (!loreResult.isConsistent) {
      warnings.push(...loreResult.warnings);
      suggestions.push(...loreResult.suggestions);
      confidence *= loreResult.confidence;
      evidenceParts.push(`Lore: ${loreResult.evidence}`);
    }
    // Aggregate boundaries from lore check
    if (loreResult.boundaries) {
      boundaries.push(...loreResult.boundaries);
    }
  }

  // 3. Causal Logic Check (KDE-ENGINE-003 Gamma: Causal Mechanism)
  if (opts.checkCausality && summaries.length > 0) {
    const causalResult = await checkCausalLogic(storyId, chapterContent, summaries, aiOptions);
    if (!causalResult.isConsistent) {
      warnings.push(...causalResult.warnings);
      suggestions.push(...causalResult.suggestions);
      confidence *= causalResult.confidence;
      evidenceParts.push(`Causality: ${causalResult.evidence}`);
    }
    // Capture causal mechanism explanation
    if (causalResult.mechanism) {
      mechanism = causalResult.mechanism;
    }
  }

  const level = confidence >= CONFIDENCE_HIGH ? 'high' 
    : confidence >= CONFIDENCE_MEDIUM ? 'medium' 
    : 'low';

  return {
    isConsistent: warnings.length === 0,
    confidence: Math.round(confidence * 100) / 100,
    level,
    warnings,
    suggestions: suggestions.length > 0 ? suggestions : ['No issues detected'],
    evidence: evidenceParts.join('; ') || 'Chapter appears consistent',
    boundaries: boundaries.length > 0 ? boundaries : undefined,
    mechanism: mechanism || undefined
  };
}

/**
 * Check if character actions in the chapter are consistent with their profiles.
 * (KDE-ENGINE-002 Beta: Context Detection + Boundary Detection)
 */
async function checkCharacterConsistency(storyId, content, characters, aiOptions) {
  const warnings = [];
  const suggestions = [];
  const boundaries = [];

  // Extract speakers from chapter
  const speakers = extractSpeakers(content);

  // ── Name & Place Localization: recognise canonical names + source aliases ──
  // When localization is active, a chapter may refer to "Cedric Vale" while the
  // character profile still lists the source name "Wei Chen" (the entity map is
  // the source of truth — profiles are not mutated). Build the characterMap so
  // that BOTH the source name AND the canonical name resolve to the SAME
  // character, so coherence never reports them as two different characters.
  const locMap = localization.isActive(storyId) ? localization.loadEntityMap(storyId) : null;
  const resolveName = locMap
    ? (name) => localization.resolveNameWithMap(locMap, name)
    : null;
  const characterMap = new Map();
  for (const c of characters) {
    characterMap.set(c.name.toLowerCase(), c);
    if (locMap) {
      const canonical = localization.resolveNameWithMap(locMap, c.name);
      if (canonical && canonical.toLowerCase() !== c.name.toLowerCase()) {
        characterMap.set(canonical.toLowerCase(), c);
      }
    }
  }

  // Check each named speaker
  for (const speaker of speakers) {
    const char = characterMap.get(speaker.toLowerCase());
    if (!char) {
      // New character - will be handled by auto-extraction
      continue;
    }

    // Build character context for AI check. Pass the canonical display name
    // (when localization is active) so the LLM sees the same name the chapter
    // uses — otherwise it would flag a "name change" that is actually the same
    // entity.
    const prompt = buildCharacterCheckPrompt(char, content, resolveName);
    
    try {
      const raw = await ai.ask(prompt, aiOptions);
      const result = parseCoherenceResponse(raw);

      // Display name used in user-facing warnings (canonical when localized).
      const displayName = resolveName ? resolveName(char.name) : char.name;

      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) {
          warnings.push(`${displayName}: ${issue.description}`);
          suggestions.push(`Consider: ${issue.suggestion}`);
        }
      }
      
      // Extract boundary conditions from response
      if (result.boundaries && result.boundaries.length > 0) {
        for (const boundary of result.boundaries) {
          boundaries.push(`${displayName}: ${boundary}`);
        }
      }
    } catch {
      // AI call failed - be conservative
      warnings.push(`${speaker}: Could not verify consistency (AI unavailable)`);
    }
  }

  const confidence = warnings.length === 0 ? 1.0 
    : warnings.length <= 2 ? 0.7 
    : 0.4;

  return {
    isConsistent: warnings.length === 0,
    confidence,
    warnings,
    suggestions,
    evidence: warnings.length === 0 
      ? 'All character actions align with established personalities' 
      : `${warnings.length} character inconsistency(ies) detected`,
    boundaries: boundaries.length > 0 ? boundaries : undefined
  };
}

/**
 * Check if the chapter respects established world/lore rules.
 * (KDE-ENGINE-002 Beta: Context Detection + Boundary Detection)
 * 
 * Asks: "Under what conditions is this rule valid? When does it stop being true?"
 */
async function checkLoreConsistency(storyId, content, lore, aiOptions) {
  const warnings = [];
  const suggestions = [];
  const boundaries = [];

  // Build lore context
  const loreContext = lore.map(l => `[${l.title}]: ${l.content}`).join('\n');

  const prompt = [
    'You are a creative writing assistant checking for world consistency.',
    'Review the chapter against the established world rules and flag any violations.',
    '',
    'KDE-BETA CORE QUESTIONS (Boundary Detection):',
    '- Under what conditions is each world rule valid?',
    '- When does each rule stop being true? (explicit boundary)',
    '- What would cause this rule to break or change?',
    '',
    'World Rules:',
    loreContext,
    '',
    'Chapter to check:',
    content.slice(0, 2000), // Limit content for check
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "violations": [{"rule": "rule name", "description": "what was violated", "suggestion": "how to fix"}], "boundaries": [{"rule": "rule name", "boundary": "when this rule stops being true"}], "confidence": 0.0-1.0 }',
    'If no violations, set violations to [] and confidence to 1.0.',
    'Always include boundaries - they are key for understanding when rules change.',
  ].join('\n');

  try {
    const raw = await ai.ask(prompt, aiOptions);
    const result = parseCoherenceResponse(raw);

    if (result.violations && result.violations.length > 0) {
      for (const v of result.violations) {
        warnings.push(`World rule "${v.rule}": ${v.description}`);
        suggestions.push(`Suggestion: ${v.suggestion}`);
      }
    }
    
    // Extract boundaries
    if (result.boundaries && result.boundaries.length > 0) {
      for (const b of result.boundaries) {
        boundaries.push(`${b.rule}: ${b.boundary}`);
      }
    }
  } catch {
    warnings.push('Could not verify world consistency (AI unavailable)');
  }

  const confidence = warnings.length === 0 ? 1.0 
    : warnings.length <= 2 ? 0.7 
    : 0.4;

  return {
    isConsistent: warnings.length === 0,
    confidence,
    warnings,
    suggestions,
    evidence: warnings.length === 0 
      ? 'Chapter respects all established world rules' 
      : `${warnings.length} world rule violation(s) detected`,
    boundaries: boundaries.length > 0 ? boundaries : undefined
  };
}

/**
 * Check causal logic - do events follow logically from previous chapters?
 * (KDE-ENGINE-003 Gamma: Causal Mechanism)
 * 
 * Asks: "How does X cause Y? What consequence does this set up?"
 */
async function checkCausalLogic(storyId, content, summaries, aiOptions) {
  const warnings = [];
  const suggestions = [];
  let mechanism = '';

  // Build chapter history
  const history = summaries
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(s => `Chapter ${s.id.replace('summary-', '')}: ${s.content}`)
    .join('\n\n');

  const prompt = [
    'You are a creative writing assistant checking for narrative continuity.',
    'Verify that events in the new chapter follow logically from previous chapters.',
    '',
    'KDE-GAMMA CORE QUESTIONS (Causal Mechanism):',
    '- How does event X cause event Y? (trace the causal chain)',
    '- What is the character motivation driving each action?',
    '- What consequence does each cause set up?',
    '- Are there causal gaps (effects without mechanisms)?',
    '',
    'Look for:',
    '- Unresolved plot threads from earlier chapters',
    '- New events that contradict established facts',
    '- Character changes without proper motivation',
    '- Missing causal links between events',
    '',
    'Previous chapters:',
    history.slice(0, 2000),
    '',
    'New chapter:',
    content.slice(0, 1500),
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "issues": [{"type": "type", "description": "what is inconsistent", "suggestion": "fix"}], "mechanism": "Explain how the key events connect causally: motivation -> action -> consequence", "confidence": 0.0-1.0 }',
    'If no issues, set issues to [] and confidence to 1.0.',
    'Include a mechanism explanation even when consistent - it helps writers understand the causal flow.',
  ].join('\n');

  try {
    const raw = await ai.ask(prompt, aiOptions);
    const result = parseCoherenceResponse(raw);

    if (result.issues && result.issues.length > 0) {
      for (const issue of result.issues) {
        warnings.push(`Continuity: ${issue.description}`);
        suggestions.push(`Suggestion: ${issue.suggestion}`);
      }
    }
    
    // Capture causal mechanism explanation
    if (result.mechanism) {
      mechanism = result.mechanism;
    }
  } catch {
    warnings.push('Could not verify continuity (AI unavailable)');
  }

  const confidence = warnings.length === 0 ? 1.0 
    : warnings.length <= 2 ? 0.7 
    : 0.4;

  return {
    isConsistent: warnings.length === 0,
    confidence,
    warnings,
    suggestions,
    evidence: warnings.length === 0 
      ? 'Chapter follows logically from story history' 
      : `${warnings.length} continuity issue(s) detected`,
    mechanism: mechanism || undefined
  };
}

/**
 * Validate a character profile for internal consistency.
 * Checks if personality traits are compatible with role and backstory.
 * 
 * @param {Object} character - Character profile to validate
 * @returns {Object} Validation result
 */
function validateCharacterProfile(character) {
  const warnings = [];
  const suggestions = [];

  const traits = (character.personality || '').toLowerCase().split(',').map(t => t.trim());
  const role = (character.role || '').toLowerCase();

  // Check for contradictory traits
  const contradictions = [
    ['brave', 'cowardly'], ['honest', 'deceitful'], ['loyal', 'treacherous'],
    ['kind', 'cruel'], ['confident', 'insecure'], ['calm', 'volatile']
  ];

  for (const [trait1, trait2] of contradictions) {
    const has1 = traits.some(t => t.includes(trait1));
    const has2 = traits.some(t => t.includes(trait2));
    if (has1 && has2) {
      warnings.push(`Potentially contradictory traits: "${trait1}" and "${trait2}"`);
      suggestions.push('Consider focusing on one dominant trait or explaining the contradiction');
    }
  }

  // Check role-trait alignment
  const roleTraitAlignments = {
    'villain': ['cruel', 'ambitious', 'cunning', 'manipulative', 'ruthless'],
    'hero': ['brave', 'noble', 'selfless', 'honorable', 'courageous'],
    'mentor': ['wise', 'patient', 'experienced', 'guidance', 'sage'],
    'rogue': ['cunning', 'independent', 'resourceful', 'shady', 'elusive']
  };

  if (roleTraitAlignments[role]) {
    const alignedTraits = traits.filter(t => 
      roleTraitAlignments[role].some(rt => t.includes(rt))
    );
    if (alignedTraits.length === 0) {
      warnings.push(`${role} role has no matching personality traits`);
      suggestions.push(`Consider adding traits aligned with typical ${role} archetypes`);
    }
  }

  return {
    isValid: warnings.length === 0,
    warnings,
    suggestions,
    confidence: warnings.length === 0 ? 1.0 : warnings.length <= 1 ? 0.7 : 0.4
  };
}

/**
 * Generate intervention/thought experiment: "What if" analysis.
 * (KDE-ENGINE-003 Gamma: Intervention Thinking)
 * 
 * Asks: "What happens if we change X? How does that affect Y?"
 * 
 * @param {string} storyId - The story ID
 * @param {string} question - What-if question
 * @param {Object} aiOptions - AI transport options
 * @returns {Promise<Object>} Intervention result
 */
async function whatIf(storyId, question, aiOptions = {}) {
  const characters = storyRag.listDocs(storyId, 'character');
  const lore = storyRag.listDocs(storyId, 'lore');
  
  const context = [
    'Characters:',
    characters.map(c => `${c.name} (${c.role}): ${c.personality}`).join('\n'),
    '',
    'World:',
    lore.map(l => `${l.title}: ${l.content}`).join('\n')
  ].join('\n');

  const prompt = [
    'You are a creative writing consultant exploring story alternatives.',
    '',
    'KDE-GAMMA CORE QUESTIONS (Intervention Thinking):',
    '- What happens if we change X? (intervention)',
    '- How does that affect Y? (ripple effect)',
    '- What new causal chains emerge?',
    '- What story rules get bent or broken?',
    '',
    'Ground your analysis in established story rules, then explore possibilities.',
    '',
    'Story Context:',
    context,
    '',
    'Intervention question to explore:',
    question,
    '',
    'Respond with ONLY a valid JSON object:',
    '{',
    '  "premise": "Is this intervention consistent with the story world? (yes/no/maybe)",',
    '  "mechanism": "How does this change ripple through the story? (causal chain)",',
    '  "consequences": ["likely consequence 1", "consequence 2"],',
    '  "characterImpact": "How might key characters respond to this change?",',
    '  "boundaries": ["When does this intervention break down?", "What are the limits?"],',
    '  "risks": ["potential story problem 1"],',
    '  "opportunities": ["story opportunity 1"],',
    '  "confidence": 0.0-1.0',
    '}',
  ].join('\n');

  try {
    const raw = await ai.ask(prompt, aiOptions);
    const result = parseCoherenceResponse(raw);
    return {
      question,
      answer: result,
      success: true
    };
  } catch (e) {
    return {
      question,
      answer: { error: 'Could not process what-if analysis' },
      success: false,
      error: e.message
    };
  }
}

/**
 * Extract unique speaker names from chapter content.
 */
function extractSpeakers(content) {
  const speakers = new Set();
  // Allow spaces so multi-word canonical names (e.g. "Cedric Vale") from Name &
  // Place Localization are recognised, not truncated to "Cedric".
  const re = /\[speaker:([A-Za-z0-9 _-]+)\]/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const name = match[1];
    if (!GENERIC_SPEAKERS.has(name.toLowerCase())) {
      speakers.add(name);
    }
  }
  return [...speakers];
}

/**
 * Build prompt for character consistency checking.
 * (KDE-ENGINE-002 Beta: Asks "When does this trait stop being true?")
 */
function buildCharacterCheckPrompt(character, content, resolveName) {
  const resolve = typeof resolveName === 'function' ? resolveName : ((n) => n);
  const name = resolve(character.name);
  return [
    'You are a creative writing assistant checking character consistency.',
    'Evaluate if the chapter maintains consistency with this character profile.',
    '',
    'KDE-BETA CORE QUESTIONS:',
    '- Under what conditions is this character\'s behavior valid?',
    '- When does this character trait stop being true? (Boundary Detection)',
    '',
    'Character Profile:',
    `Name: ${name}`,
    `Role: ${character.role}`,
    `Gender: ${character.gender}`,
    `Personality: ${character.personality}`,
    `Backstory: ${character.backstory || 'Not specified'}`,
    '',
    'Chapter excerpt (first 1500 chars):',
    content.slice(0, 1500),
    '',
    'Check for:',
    '- Actions that contradict established personality traits',
    '- Dialogue inconsistent with speech style or character voice',
    '- Decisions that don\'t align with character motivations',
    '- Relationships with other characters that have changed without explanation',
    '- BOUNDARIES: Under what conditions would this character act differently?',
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "issues": [{"description": "what is inconsistent", "suggestion": "how to fix"}], "boundaries": ["boundary condition 1", "when trait X stops being true"], "confidence": 0.0-1.0 }',
    'If no issues, set issues to [] and confidence to 1.0. Include boundaries if the character has specific boundary conditions.',
  ].join('\n');
}

/**
 * Parse AI coherence response, handling malformed JSON gracefully.
 */
function parseCoherenceResponse(raw) {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
  } catch {
    // Fall through
  }
  return {};
}

/**
 * Get coherence summary for a story's current state.
 * Provides a quick overview of story health.
 * 
 * @param {string} storyId - The story ID
 * @returns {Promise<Object>} Summary of story coherence
 */
async function getStoryHealth(storyId) {
  const characters = storyRag.listDocs(storyId, 'character');
  const lore = storyRag.listDocs(storyId, 'lore');
  const summaries = storyRag.listDocs(storyId, 'summary');

  const charWarnings = [];
  let charScore = 1.0;
  
  for (const char of characters) {
    const validation = validateCharacterProfile(char);
    if (!validation.isValid) {
      charWarnings.push(...validation.warnings);
      charScore *= validation.confidence;
    }
  }

  return {
    storyId,
    health: {
      characters: {
        count: characters.length,
        score: Math.round(charScore * 100) / 100,
        warnings: charWarnings.slice(0, 3),
        issues: charWarnings.length
      },
      world: {
        count: lore.length,
        score: lore.length > 0 ? 1.0 : 0.8, // Less established = less to violate
        warnings: []
      },
      continuity: {
        chapters: summaries.length,
        score: summaries.length >= 3 ? 1.0 : 0.8, // More chapters = more to check
        warnings: []
      }
    },
    overallScore: Math.round(
      ((charScore + (lore.length > 0 ? 1.0 : 0.8) + (summaries.length >= 3 ? 1.0 : 0.8)) / 3) * 100
    ) / 100,
    recommendations: charWarnings.length > 0
      ? ['Review character profiles for contradictions']
      : ['Story structure looks healthy']
  };
}

module.exports = {
  checkChapter,
  checkCharacterConsistency,
  checkLoreConsistency,
  checkCausalLogic,
  validateCharacterProfile,
  whatIf,
  getStoryHealth,
  CONFIDENCE_HIGH,
  CONFIDENCE_MEDIUM,
  CONFIDENCE_LOW
};

'use strict';

/**
 * Story Coherence Engine
 * 
 * A lightweight layer for validating narrative consistency, inspired by KDE Beta/Gamma
 * reasoning patterns. Provides context detection, boundary checking, causal validation,
 * and confidence scoring for creative storytelling.
 * 
 * Key Concepts:
 * - Context: The conditions under which a story element is valid/true
 * - Boundary: When a rule, trait, or development stops being valid
 * - Confidence: How certain the coherence check is (0-1 scale)
 * - Evidence: The reasoning that led to the confidence score
 * - Causal Chain: How events connect through motivation and consequence
 */

const ai = require('../lib/ai');
const storyRag = require('./story-rag');

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
 * @property {string} evidence - Brief explanation of the check
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
  let confidence = 1.0;
  let evidenceParts = [];

  // Gather story context
  const characters = storyRag.listDocs(storyId, 'character');
  const lore = storyRag.listDocs(storyId, 'lore');
  const summaries = storyRag.listDocs(storyId, 'summary');

  // 1. Character Consistency Check
  if (opts.checkCharacters && characters.length > 0) {
    const charResult = await checkCharacterConsistency(storyId, chapterContent, characters, aiOptions);
    if (!charResult.isConsistent) {
      warnings.push(...charResult.warnings);
      suggestions.push(...charResult.suggestions);
      confidence *= charResult.confidence;
      evidenceParts.push(`Characters: ${charResult.evidence}`);
    }
  }

  // 2. Lore/World Rules Check
  if (opts.checkLore && lore.length > 0) {
    const loreResult = await checkLoreConsistency(storyId, chapterContent, lore, aiOptions);
    if (!loreResult.isConsistent) {
      warnings.push(...loreResult.warnings);
      suggestions.push(...loreResult.suggestions);
      confidence *= loreResult.confidence;
      evidenceParts.push(`Lore: ${loreResult.evidence}`);
    }
  }

  // 3. Causal Logic Check
  if (opts.checkCausality && summaries.length > 0) {
    const causalResult = await checkCausalLogic(storyId, chapterContent, summaries, aiOptions);
    if (!causalResult.isConsistent) {
      warnings.push(...causalResult.warnings);
      suggestions.push(...causalResult.suggestions);
      confidence *= causalResult.confidence;
      evidenceParts.push(`Causality: ${causalResult.evidence}`);
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
    evidence: evidenceParts.join('; ') || 'Chapter appears consistent'
  };
}

/**
 * Check if character actions in the chapter are consistent with their profiles.
 */
async function checkCharacterConsistency(storyId, content, characters, aiOptions) {
  const warnings = [];
  const suggestions = [];

  // Extract speakers from chapter
  const speakers = extractSpeakers(content);
  const characterMap = new Map(characters.map(c => [c.name.toLowerCase(), c]));

  // Check each named speaker
  for (const speaker of speakers) {
    const char = characterMap.get(speaker.toLowerCase());
    if (!char) {
      // New character - will be handled by auto-extraction
      continue;
    }

    // Build character context for AI check
    const prompt = buildCharacterCheckPrompt(char, content);
    
    try {
      const raw = await ai.ask(prompt, aiOptions);
      const result = parseCoherenceResponse(raw);

      if (result.issues && result.issues.length > 0) {
        for (const issue of result.issues) {
          warnings.push(`${char.name}: ${issue.description}`);
          suggestions.push(`Consider: ${issue.suggestion}`);
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
      : `${warnings.length} character inconsistency(ies) detected`
  };
}

/**
 * Check if the chapter respects established world/lore rules.
 */
async function checkLoreConsistency(storyId, content, lore, aiOptions) {
  const warnings = [];
  const suggestions = [];

  // Build lore context
  const loreContext = lore.map(l => `[${l.title}]: ${l.content}`).join('\n');

  const prompt = [
    'You are a creative writing assistant checking for world consistency.',
    'Review the chapter against the established world rules and flag any violations.',
    '',
    'World Rules:',
    loreContext,
    '',
    'Chapter to check:',
    content.slice(0, 2000), // Limit content for check
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "violations": [{"rule": "rule name", "description": "what was violated", "suggestion": "how to fix"}], "confidence": 0.0-1.0 }',
    'If no violations, set violations to [] and confidence to 1.0.',
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
      : `${warnings.length} world rule violation(s) detected`
  };
}

/**
 * Check causal logic - do events follow logically from previous chapters?
 */
async function checkCausalLogic(storyId, content, summaries, aiOptions) {
  const warnings = [];
  const suggestions = [];

  // Build chapter history
  const history = summaries
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(s => `Chapter ${s.id.replace('summary-', '')}: ${s.content}`)
    .join('\n\n');

  const prompt = [
    'You are a creative writing assistant checking for narrative continuity.',
    'Verify that events in the new chapter follow logically from previous chapters.',
    'Look for:',
    '- Unresolved plot threads from earlier chapters',
    '- New events that contradict established facts',
    '- Character changes without proper motivation',
    '',
    'Previous chapters:',
    history.slice(0, 2000),
    '',
    'New chapter:',
    content.slice(0, 1500),
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "issues": [{"type": "type", "description": "what is inconsistent", "suggestion": "fix"}], "confidence": 0.0-1.0 }',
    'If no issues, set issues to [] and confidence to 1.0.',
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
      : `${warnings.length} continuity issue(s) detected`
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
 * Explores alternative story directions while staying grounded.
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
    'Ground your analysis in established story rules, then explore possibilities.',
    '',
    'Story Context:',
    context,
    '',
    'Question to explore:',
    question,
    '',
    'Respond with ONLY a valid JSON object:',
    '{',
    '  "premise": "Is this premise consistent with the story world? (yes/no/maybe)",',
    '  "consequences": ["likely consequence 1", "consequence 2"],',
    '  "characterImpact": "How might key characters respond?",',
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
  const re = /\[speaker:([A-Za-z0-9_-]+)\]/g;
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
 */
function buildCharacterCheckPrompt(character, content) {
  return [
    'You are a creative writing assistant checking character consistency.',
    'Evaluate if the chapter maintains consistency with this character profile.',
    '',
    'Character Profile:',
    `Name: ${character.name}`,
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
    '',
    'Respond with ONLY a valid JSON object:',
    '{ "issues": [{"description": "what is inconsistent", "suggestion": "how to fix"}], "confidence": 0.0-1.0 }',
    'If no issues, set issues to [] and confidence to 1.0.',
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

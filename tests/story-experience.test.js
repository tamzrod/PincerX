'use strict';

// Mock dependencies — no real LLM/HTTP calls.
jest.mock('../lib/ai');
jest.mock('../story/story-rag');

const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const experience = require('../story/story-experience');

afterEach(() => {
  jest.clearAllMocks();
});

// A well-formed synthesis response the "LLM" returns.
const SYNTH_RESPONSE = JSON.stringify({
  currentState: { curiosity: 60, tension: 40, emotionalInvestment: 30, mystery: 70, anticipation: 50 },
  targetState: { curiosity: 84, tension: 72, emotionalInvestment: 74, mystery: 86, anticipation: 91 },
  readerQuestions: ['Why does Cedric know about the contract?', 'Who created the trap?'],
  knowledgeManagement: {
    reveal: ['The contract contains a hidden trap.'],
    withhold: ["Cedric's true identity."],
    foreshadow: ['A symbol on the contract reappears later.'],
  },
  narrativeObjectives: ['Reveal the business crisis is deliberate.'],
  emotionalTrajectory: ['curiosity', 'suspicion', 'tension', 'shock', 'relief'],
  readerShouldDiscover: ['The contract contains a hidden trap.'],
  readerShouldNotDiscover: ["Cedric's true identity."],
  characterObjective: 'Cedric must protect Isabella without revealing his capabilities.',
  endingState: 'Immediate danger resolved, stronger question remains.',
  nextChapterPull: 'Who created the trap, and why does Cedric already know?',
});

const ANALYSIS_RESPONSE = JSON.stringify({
  passed: false,
  observed: { curiosity: 'increased', tension: 'increased', mystery: 'decreased too early' },
  issues: ['Mystery was revealed too early.'],
  recommendation: 'Preserve the mystery surrounding Cedric while revealing the consequence.',
  newReaderState: { curiosity: 84, tension: 72, emotionalInvestment: 74, mystery: 50, anticipation: 91 },
  resolvedQuestions: ['Who created the trap?'],
  newQuestions: ['What is Cedric hiding about his past?'],
});

const SAMPLE_CONFIG = { primary: 'Curiosity', secondary: 'Tension', intensity: 'High', pacing: 'Moderate' };

// ── validateConfig ──────────────────────────────────────────────────────────

describe('experience.validateConfig()', () => {
  it('accepts a valid config and normalises category casing', () => {
    const { valid, errors, normalized } = experience.validateConfig({
      primary: 'curiosity', secondary: 'tension', intensity: 'high', pacing: 'moderate',
    });
    expect(valid).toBe(true);
    expect(errors).toHaveLength(0);
    expect(normalized).toEqual(SAMPLE_CONFIG);
  });

  it('rejects an invalid category', () => {
    const { valid, errors } = experience.validateConfig({ primary: 'Boredom', secondary: 'Tension', intensity: 'High', pacing: 'Moderate' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('primary'))).toBe(true);
  });

  it('rejects primary === secondary', () => {
    const { valid, errors } = experience.validateConfig({ primary: 'Curiosity', secondary: 'Curiosity', intensity: 'High', pacing: 'Moderate' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('differ'))).toBe(true);
  });

  it('rejects invalid intensity and pacing', () => {
    const { valid, errors } = experience.validateConfig({ primary: 'Curiosity', secondary: 'Tension', intensity: 'Bananas', pacing: 'Glacial' });
    expect(valid).toBe(false);
    expect(errors.some((e) => e.includes('intensity'))).toBe(true);
    expect(errors.some((e) => e.includes('pacing'))).toBe(true);
  });

  it('rejects non-object input', () => {
    const { valid } = experience.validateConfig(null);
    expect(valid).toBe(false);
  });
});

// ── parseSynthesisResponse ──────────────────────────────────────────────────

describe('experience.parseSynthesisResponse()', () => {
  it('parses a well-formed JSON response', () => {
    const obj = experience.parseSynthesisResponse(SYNTH_RESPONSE);
    expect(obj).not.toBeNull();
    expect(obj.targetState.curiosity).toBe(84);
    expect(obj.readerQuestions).toHaveLength(2);
    expect(obj.knowledgeManagement.withhold).toEqual(["Cedric's true identity."]);
    expect(obj.emotionalTrajectory).toEqual(['curiosity', 'suspicion', 'tension', 'shock', 'relief']);
    expect(obj.nextChapterPull).toContain('Who created the trap');
  });

  it('tolerates prose around the JSON', () => {
    const obj = experience.parseSynthesisResponse('Here is the objective:\n' + SYNTH_RESPONSE + '\nDone.');
    expect(obj).not.toBeNull();
    expect(obj.characterObjective).toContain('Cedric');
  });

  it('clamps state values to 0-100 integers', () => {
    const obj = experience.parseSynthesisResponse(JSON.stringify({
      currentState: { curiosity: 250, tension: -10 },
      targetState: {},
    }));
    expect(obj.currentState.curiosity).toBe(100);
    expect(obj.currentState.tension).toBe(0);
  });

  it('returns null for unparseable input', () => {
    expect(experience.parseSynthesisResponse('no json here')).toBeNull();
    expect(experience.parseSynthesisResponse('')).toBeNull();
    expect(experience.parseSynthesisResponse(null)).toBeNull();
  });

  it('normalises missing arrays to empty arrays', () => {
    const obj = experience.parseSynthesisResponse(JSON.stringify({ currentState: {}, targetState: {} }));
    expect(obj.readerQuestions).toEqual([]);
    expect(obj.knowledgeManagement.reveal).toEqual([]);
    expect(obj.narrativeObjectives).toEqual([]);
  });
});

// ── parseAnalysisResponse ───────────────────────────────────────────────────

describe('experience.parseAnalysisResponse()', () => {
  it('parses findings with observed dimensions', () => {
    const f = experience.parseAnalysisResponse(ANALYSIS_RESPONSE);
    expect(f).not.toBeNull();
    expect(f.passed).toBe(false);
    expect(f.observed.mystery).toBe('decreased too early');
    expect(f.issues).toEqual(['Mystery was revealed too early.']);
    expect(f.recommendation).toContain('Preserve the mystery');
    expect(f.newReaderState.curiosity).toBe(84);
  });

  it('returns null for unparseable input', () => {
    expect(experience.parseAnalysisResponse('nope')).toBeNull();
  });
});

// ── detectRepetition ────────────────────────────────────────────────────────

describe('experience.detectRepetition()', () => {
  it('detects a repeated protagonist-wins pattern', () => {
    storyRag.listDocs.mockImplementation((_id, type) => {
      if (type === 'summary') {
        return [
          { chapterNumber: 1, content: 'The hero defeated the villain.' },
          { chapterNumber: 2, content: 'She won the duel.' },
          { chapterNumber: 3, content: 'He triumphed again.' },
        ];
      }
      return [];
    });
    const r = experience.detectRepetition('story-1');
    expect(r.detected).toBe(true);
    expect(r.pattern).toBe('protagonist_wins');
    expect(r.count).toBeGreaterThanOrEqual(3);
    expect(r.suggestion).toMatch(/Vary the outcome/);
  });

  it('does not flag repetition below the threshold', () => {
    storyRag.listDocs.mockImplementation((_id, type) => {
      if (type === 'summary') {
        return [
          { chapterNumber: 1, content: 'The hero defeated the villain.' },
          { chapterNumber: 2, content: 'A quiet day with no conflict.' },
        ];
      }
      return [];
    });
    const r = experience.detectRepetition('story-2');
    expect(r.detected).toBe(false);
  });

  it('returns no detection when there are no summaries', () => {
    storyRag.listDocs.mockReturnValue([]);
    const r = experience.detectRepetition('story-3');
    expect(r.detected).toBe(false);
    expect(r.evidence).toEqual([]);
  });
});

// ── synthesizeObjective ─────────────────────────────────────────────────────

describe('experience.synthesizeObjective()', () => {
  beforeEach(() => {
    storyRag.getExperienceConfig.mockReturnValue(SAMPLE_CONFIG);
    storyRag.getExperienceState.mockReturnValue(null);
    storyRag.listDocs.mockReturnValue([]);
  });

  it('synthesises a structured objective from an LLM response', async () => {
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    const result = await experience.synthesizeObjective('story-1', 2, { model: 'gemma3:27b' });

    expect(result.synthesized).toBe(true);
    expect(result.objective).not.toBeNull();
    expect(result.objective.targetState.curiosity).toBe(84);
    expect(result.objective.chapterNumber).toBe(2);
    expect(result.objective.config).toEqual(SAMPLE_CONFIG);
  });

  it('passes the UI-selected model through to ai.ask', async () => {
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    await experience.synthesizeObjective('story-1', 2, { model: 'gemma3:27b', onToken: () => {}, maxTokens: 9999 });
    // Model is forwarded; streaming hooks + maxTokens are stripped.
    expect(ai.ask).toHaveBeenCalledWith(expect.any(String), { model: 'gemma3:27b' });
  });

  it('does NOT silently fall back to a different model', async () => {
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    await experience.synthesizeObjective('story-1', 2, { model: 'gemma3:27b' });
    const opts = ai.ask.mock.calls[0][1];
    expect(opts.model).toBe('gemma3:27b');
    expect(opts.model).not.toBe('qwen2.5-coder:14b');
  });

  it('marks Chapter 1 as special and includes acquisition framing', async () => {
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    const result = await experience.synthesizeObjective('story-1', 1);
    expect(result.chapter1).toBe(true);
    expect(result.objective.chapter1).toBe(true);
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/CHAPTER 1 IS SPECIAL/i);
    expect(prompt).toMatch(/immediate engagement/i);
    expect(prompt).toMatch(/Why should a new listener continue listening/i);
  });

  it('uses retention framing for later chapters', async () => {
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    await experience.synthesizeObjective('story-1', 5);
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/RETENTION rather than acquisition/i);
    expect(prompt).not.toMatch(/CHAPTER 1 IS SPECIAL/);
  });

  it('includes detected repetition evidence in the synthesis prompt', async () => {
    storyRag.listDocs.mockImplementation((_id, type) => {
      if (type === 'summary') {
        return [
          { chapterNumber: 1, content: 'Hero defeated the foe.' },
          { chapterNumber: 2, content: 'Hero won again.' },
          { chapterNumber: 3, content: 'Hero triumphed.' },
        ];
      }
      return [];
    });
    ai.ask.mockResolvedValue(SYNTH_RESPONSE);
    await experience.synthesizeObjective('story-1', 4);
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/Detected repetition/);
    expect(prompt).toMatch(/protagonist_wins/);
  });

  it('soft-fails (no throw) when the LLM is unreachable', async () => {
    ai.ask.mockRejectedValue(new Error('AI request failed: connect ECONNREFUSED'));
    const result = await experience.synthesizeObjective('story-1', 2);
    expect(result.synthesized).toBe(false);
    expect(result.objective).toBeNull();
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it('soft-fails when the LLM returns unparseable output', async () => {
    ai.ask.mockResolvedValue('totally not json at all');
    const result = await experience.synthesizeObjective('story-1', 2);
    expect(result.synthesized).toBe(false);
    expect(result.objective).toBeNull();
  });

  it('returns synthesized:false without calling the LLM when no config is set', async () => {
    storyRag.getExperienceConfig.mockReturnValue(null);
    const result = await experience.synthesizeObjective('story-1', 2);
    expect(result.synthesized).toBe(false);
    expect(ai.ask).not.toHaveBeenCalled();
  });
});

// ── analyzeChapter ──────────────────────────────────────────────────────────

describe('experience.analyzeChapter()', () => {
  const objective = experience.parseSynthesisResponse(SYNTH_RESPONSE);

  beforeEach(() => {
    storyRag.getExperienceState.mockReturnValue(null);
    storyRag.saveExperienceState.mockImplementation((_id, state) => state);
  });

  it('analyses a chapter against the objective and returns findings', async () => {
    ai.ask.mockResolvedValue(ANALYSIS_RESPONSE);
    const result = await experience.analyzeChapter('story-1', 2, 'Chapter content here.', objective, { model: 'gemma3:27b' });
    expect(result.analyzed).toBe(true);
    expect(result.findings.passed).toBe(false);
    expect(result.findings.observed.mystery).toBe('decreased too early');
    expect(result.findings.recommendation).toContain('Preserve the mystery');
  });

  it('respects the UI-selected model', async () => {
    ai.ask.mockResolvedValue(ANALYSIS_RESPONSE);
    await experience.analyzeChapter('story-1', 2, 'content', objective, { model: 'gemma3:27b' });
    expect(ai.ask).toHaveBeenCalledWith(expect.any(String), { model: 'gemma3:27b' });
  });

  it('soft-fails (no throw) when the LLM is unreachable', async () => {
    ai.ask.mockRejectedValue(new Error('AI offline'));
    const result = await experience.analyzeChapter('story-1', 2, 'content', objective);
    expect(result.analyzed).toBe(false);
    expect(result.findings).toBeNull();
    expect(result.error).toMatch(/AI offline/);
  });

  it('soft-fails when no objective is provided', async () => {
    const result = await experience.analyzeChapter('story-1', 2, 'content', null);
    expect(result.analyzed).toBe(false);
    expect(ai.ask).not.toHaveBeenCalled();
  });

  it('evolves the stored Reader Experience state after a successful analysis', async () => {
    storyRag.getExperienceState.mockReturnValue({
      config: SAMPLE_CONFIG,
      readerQuestions: ['Who created the trap?', 'Why does Cedric know?'],
      trajectory: [],
    });
    ai.ask.mockResolvedValue(ANALYSIS_RESPONSE);
    await experience.analyzeChapter('story-1', 2, 'content', objective);
    expect(storyRag.saveExperienceState).toHaveBeenCalledWith('story-1', expect.objectContaining({
      currentState: expect.objectContaining({ curiosity: 84 }),
      lastChapterNumber: 2,
    }));
    const saved = storyRag.saveExperienceState.mock.calls[0][1];
    // Resolved question removed, new question appended.
    expect(saved.readerQuestions).not.toContain('Who created the trap?');
    expect(saved.readerQuestions).toContain('What is Cedric hiding about his past?');
    expect(saved.trajectory).toHaveLength(1);
    expect(saved.trajectory[0].movement).toContain('curiosity');
  });

  it('Chapter 1 analysis prompt weights acquisition criteria', async () => {
    ai.ask.mockResolvedValue(ANALYSIS_RESPONSE);
    await experience.analyzeChapter('story-1', 1, 'content', { ...objective, chapter1: true });
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/Chapter 1/);
    expect(prompt).toMatch(/Chapter 2 anticipation/);
  });
});

// ── buildChapterObjectiveBlock ──────────────────────────────────────────────

describe('experience.buildChapterObjectiveBlock()', () => {
  it('returns empty string when no objective is given', () => {
    expect(experience.buildChapterObjectiveBlock(null)).toBe('');
  });

  it('produces a compact block with key fields and not the whole internal state', () => {
    const objective = experience.parseSynthesisResponse(SYNTH_RESPONSE);
    objective.chapter1 = false;
    const block = experience.buildChapterObjectiveBlock(objective);
    expect(block).toContain('READER EXPERIENCE OBJECTIVE');
    expect(block).toContain('curiosity → suspicion → tension');
    expect(block).toContain('The contract contains a hidden trap.');
    expect(block).toContain("Cedric's true identity.");
    expect(block).toContain('Who created the trap');
    // Does not dump raw JSON of the entire state.
    expect(block).not.toContain('"knowledgeManagement"');
  });

  it('uses Chapter 1 acquisition framing when chapter1 is true', () => {
    const objective = experience.parseSynthesisResponse(SYNTH_RESPONSE);
    objective.chapter1 = true;
    const block = experience.buildChapterObjectiveBlock(objective);
    expect(block).toContain('CHAPTER 1 (ACQUISITION)');
    expect(block).toContain('first chapter');
  });
});

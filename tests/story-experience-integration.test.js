'use strict';

// Integration test: verifies story.generateChapter wires the Reader Experience
// synthesis + analysis pipeline when a config is set, forwards the UI model,
// and folds experience findings into regeneration. Mocks ai.* (the LLM
// transport) and story-rag (the RAG store) so the ai.ask call order is fully
// deterministic; exercises the REAL story.js + story-experience.js code paths.

jest.mock('../lib/ai');
jest.mock('../story/story-rag');

const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const story = require('../story/story');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');
const CREATED_IDS = [];

afterAll(() => {
  for (const id of CREATED_IDS) {
    const f = path.join(STORIES_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function writeStory(id, data = {}) {
  fs.mkdirSync(STORIES_DIR, { recursive: true });
  const defaults = {
    id,
    title: 'Test Story',
    genre: 'fantasy',
    tone: 'epic',
    outline: 'A hero sets out on a quest.',
    createdAt: new Date().toISOString(),
    chapters: [],
  };
  fs.writeFileSync(
    path.join(STORIES_DIR, `${id}.json`),
    JSON.stringify({ ...defaults, ...data }, null, 2),
    'utf8',
  );
}

const SYNTH_RESPONSE = JSON.stringify({
  currentState: { curiosity: 60, tension: 40, mystery: 70 },
  targetState: { curiosity: 84, tension: 72, mystery: 86 },
  readerQuestions: ['Who created the trap?'],
  knowledgeManagement: { reveal: ['The trap exists.'], withhold: ["Cedric's identity."], foreshadow: [] },
  narrativeObjectives: ['Reveal the crisis is deliberate.'],
  emotionalTrajectory: ['curiosity', 'suspicion', 'tension'],
  readerShouldDiscover: ['The contract has a trap.'],
  readerShouldNotDiscover: ["Cedric's identity."],
  characterObjective: 'Cedric protects Isabella.',
  endingState: 'Danger unresolved.',
  nextChapterPull: 'Who made the trap?',
});

const ANALYSIS_RESPONSE = JSON.stringify({
  passed: false,
  observed: { curiosity: 'increased', mystery: 'decreased too early' },
  issues: ['Mystery revealed too early.'],
  recommendation: 'Preserve the mystery around Cedric.',
  newReaderState: { curiosity: 84, tension: 72, mystery: 50, anticipation: 91 },
  resolvedQuestions: [],
  newQuestions: ['What is Cedric hiding?'],
});

// With story-rag mocked to return no characters/lore/summaries, the generateChapter
// ai.ask call order is exactly: synthesis → chapter → summary → knowledge →
// (coherence makes no calls) → experience analysis.
function mockRagBasics() {
  storyRag.listDocs.mockReturnValue([]);
  storyRag.addDoc.mockImplementation(() => {});
  storyRag.removeDoc.mockReturnValue(true);
  storyRag.getDoc.mockReturnValue(null);
  storyRag.getExperienceState.mockReturnValue(null);
  storyRag.saveExperienceState.mockImplementation((_id, state) => state);
}

describe('story.generateChapter — Reader Experience integration', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('runs synthesis + analysis and returns experience findings when a config is set', async () => {
    writeStory('rex-int-1234');
    CREATED_IDS.push('rex-int-1234');
    mockRagBasics();
    storyRag.getExperienceConfig.mockReturnValue({ primary: 'curiosity', secondary: 'suspense', intensity: 'high', pacing: 'moderate' });

    ai.ask
      .mockResolvedValueOnce(SYNTH_RESPONSE)                                  // synthesis
      .mockResolvedValueOnce(JSON.stringify({ content: 'Cedric glanced at the contract.' })) // chapter
      .mockResolvedValueOnce('Chapter summary.')                              // summary
      .mockResolvedValueOnce(JSON.stringify({ extractions: [] }))             // knowledge
      .mockResolvedValueOnce(ANALYSIS_RESPONSE);                              // experience analysis

    const result = await story.generateChapter('rex-int-1234', 1, { model: 'gemma3:27b' });

    // Experience findings are surfaced alongside coherence.
    expect(result.experience).not.toBeNull();
    expect(result.experience.passed).toBe(false);
    expect(result.experience.observed.mystery).toBe('decreased too early');
    expect(result.experience.recommendation).toContain('Preserve the mystery');
    expect(result.experienceObjective).not.toBeNull();
    expect(result.experienceObjective.synthesized).toBe(true);
    expect(result.experienceObjective.chapter1).toBe(true);
    expect(result.experienceObjective.objective.nextChapterPull).toBe('Who made the trap?');

    // The synthesised objective block was injected into the chapter prompt.
    const chapterPrompt = ai.ask.mock.calls[1][0]; // call 0 = synthesis, 1 = chapter
    expect(chapterPrompt).toContain('READER EXPERIENCE OBJECTIVE');
    expect(chapterPrompt).toContain('CHAPTER 1 (ACQUISITION)');
    expect(chapterPrompt).toContain('Who made the trap?');

    // Model propagated to the synthesis + analysis calls (maxTokens stripped
    // from synthesis/analysis; only the chapter call carries a token budget).
    const synthOpts = ai.ask.mock.calls[0][1];
    const analysisOpts = ai.ask.mock.calls[4][1];
    expect(synthOpts.model).toBe('gemma3:27b');
    expect(synthOpts.maxTokens).toBeUndefined();
    expect(analysisOpts.model).toBe('gemma3:27b');

    // State evolution was delegated to the (mocked) RAG store.
    expect(storyRag.saveExperienceState).toHaveBeenCalledWith('rex-int-1234', expect.objectContaining({
      lastChapterNumber: 1,
      currentState: expect.objectContaining({ curiosity: 84 }),
    }));
  });

  it('skips synthesis entirely when no Reader Experience config is set', async () => {
    writeStory('rex-none-1234');
    CREATED_IDS.push('rex-none-1234');
    mockRagBasics();
    storyRag.getExperienceConfig.mockReturnValue(null); // no config → inactive

    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'A plain chapter.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify({ extractions: [] }));

    const result = await story.generateChapter('rex-none-1234', 1);

    expect(result.experience).toBeNull();
    expect(result.experienceObjective).toBeNull();
    // No objective block in the prompt.
    const chapterPrompt = ai.ask.mock.calls[0][0];
    expect(chapterPrompt).not.toContain('READER EXPERIENCE OBJECTIVE');
  });

  it('continues chapter generation when synthesis fails (soft-fail)', async () => {
    writeStory('rex-fail-1234');
    CREATED_IDS.push('rex-fail-1234');
    mockRagBasics();
    storyRag.getExperienceConfig.mockReturnValue({ primary: 'curiosity', secondary: 'suspense', intensity: 'high', pacing: 'moderate' });

    ai.ask
      .mockRejectedValueOnce(new Error('AI offline'))                       // synthesis fails
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter still written.' })) // chapter proceeds
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify({ extractions: [] }));

    const result = await story.generateChapter('rex-fail-1234', 1);

    // Chapter was still produced and saved.
    expect(result.content).toBe('Chapter still written.');
    expect(result.experience).toBeNull(); // no objective → no analysis
    expect(result.experienceObjective).not.toBeNull();
    expect(result.experienceObjective.synthesized).toBe(false);
  });

  it('folds experience findings + objective into a regeneration request', async () => {
    writeStory('rex-regen-1234', {
      chapters: [{ number: 1, content: 'Original chapter.', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    CREATED_IDS.push('rex-regen-1234');
    mockRagBasics();
    storyRag.getExperienceConfig.mockReturnValue({ primary: 'curiosity', secondary: 'suspense', intensity: 'high', pacing: 'moderate' });

    const objective = { ...JSON.parse(SYNTH_RESPONSE), chapter1: true, config: { primary: 'curiosity' } };
    const findings = { passed: false, observed: { mystery: 'decreased too early' }, recommendation: 'Preserve the mystery.', issues: ['Revealed too early.'] };

    // Regeneration reuses the provided objective (no synthesis call), so the
    // ai.ask order is: chapter → summary → knowledge → experience analysis.
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Regenerated chapter.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify({ extractions: [] }))
      .mockResolvedValueOnce(ANALYSIS_RESPONSE);

    const result = await story.generateChapter('rex-regen-1234', 1, {
      model: 'gemma3:27b',
      regenerate: {
        evidence: 'Contradicts established personality.',
        recommendation: 'Have Cedric react calmly.',
        customInstruction: 'Keep dialogue minimal.',
        experience: { findings, objective },
      },
    });

    // The regeneration prompt contains all three inputs: coherence, experience,
    // and the custom instruction — plus the experience objective block.
    const chapterPrompt = ai.ask.mock.calls[0][0];
    expect(chapterPrompt).toMatch(/Regenerate/);
    expect(chapterPrompt).toContain('Contradicts established personality.');
    expect(chapterPrompt).toContain('Have Cedric react calmly.');
    expect(chapterPrompt).toContain('Keep dialogue minimal.');
    expect(chapterPrompt).toContain('READER EXPERIENCE FEEDBACK');
    expect(chapterPrompt).toContain('Preserve the mystery.');
    expect(chapterPrompt).toContain('READER EXPERIENCE OBJECTIVE');
    // The custom instruction is still framed as additional, not a replacement.
    expect(chapterPrompt).toMatch(/do NOT ignore the coherence correction/i);

    // Experience analysis re-ran on the regenerated chapter.
    expect(result.experience).not.toBeNull();
    expect(result.experience.passed).toBe(false);
  });
});

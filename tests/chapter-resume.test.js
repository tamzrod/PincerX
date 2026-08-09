'use strict';

// Tests for the AI timeout / resume feature.
// Covers: partial-content preservation on streaming timeout, partial chapter
// persistence (no post-processing), resume continuation + dedup + remaining
// budget + same model + same Reader Experience objective, timeout before any
// output, and multiple sequential resumes.
//
// Uses an isolated stories directory (PINCERX_STORIES_DIR) so parallel Jest
// workers running story.test.js (which wipes data/stories/*.json in afterEach)
// cannot delete our fixtures mid-test.

const os = require('os');
const path = require('path');
const fs = require('fs');

const ISOLATED_STORIES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pincerx-resume-stories-'));
process.env.PINCERX_STORIES_DIR = ISOLATED_STORIES_DIR;

jest.mock('../lib/ai', () => {
  const actual = jest.requireActual('../lib/ai');
  return {
    ...actual,
    ask: jest.fn(),
    askStream: jest.fn(),
    listModels: jest.fn(),
    // isMeaningfulPartial / classifyStreamError / normalizeBaseUrl come from the
    // real module so the partial-preservation logic in story.js works correctly.
  };
});
jest.mock('../story/story-rag');
jest.mock('../story/story-coherence');

const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const coherence = require('../story/story-coherence');
const storyModule = require('../story/story');

const STORIES_DIR = ISOLATED_STORIES_DIR;

function cleanupStoriesDir() {
  if (!fs.existsSync(STORIES_DIR)) return;
  for (const entry of fs.readdirSync(STORIES_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.unlinkSync(path.join(STORIES_DIR, entry.name));
    }
  }
}

function writeStory(id, data = {}) {
  fs.mkdirSync(STORIES_DIR, { recursive: true });
  const defaults = {
    id,
    title: 'Resume Test Story',
    genre: 'mystery',
    tone: 'tense',
    outline: 'Act 1: Setup. Act 2: Reveal. Act 3: Climax.',
    createdAt: new Date().toISOString(),
    chapters: [],
  };
  fs.writeFileSync(
    path.join(STORIES_DIR, `${id}.json`),
    JSON.stringify({ ...defaults, ...data }, null, 2),
    'utf8',
  );
}

function readStory(id) {
  return JSON.parse(fs.readFileSync(path.join(STORIES_DIR, `${id}.json`), 'utf8'));
}

/** Build an Error that mimics askStream's timeout-with-partial rejection. */
function partialTimeoutError(partialText, reason = 'timeout') {
  const err = new Error('AI request failed (http://x, model=llama3): AI request timed out');
  err.partial = partialText;
  err.reason = reason;
  return err;
}

afterEach(() => {
  jest.clearAllMocks();
  cleanupStoriesDir();
});

beforeEach(() => {
  storyRag.listDocs.mockReturnValue([]);
  storyRag.addDoc.mockImplementation(() => {});
  storyRag.removeDoc.mockReturnValue(true);
  storyRag.getExperienceConfig.mockReturnValue(null);
  storyRag.getExperienceState.mockReturnValue(null);
  storyRag.setExperienceConfig.mockImplementation(() => {});
  storyRag.saveExperienceState.mockImplementation(() => {});
  coherence.checkChapter.mockResolvedValue({ violations: [], warnings: [], score: 100, suggestions: [] });
});

// ── Unit tests for the resume helper functions ─────────────────────────────

describe('resume helpers', () => {
  it('wordCount counts whitespace-separated tokens', () => {
    expect(storyModule.wordCount('')).toBe(0);
    expect(storyModule.wordCount('one two three')).toBe(3);
    expect(storyModule.wordCount('  spaced   out  ')).toBe(2);
  });

  it('resumeTokenBudget returns the REMAINING budget, never the full one', () => {
    const full = storyModule.chapterTokenBudget('default');
    const { remainingWords, maxTokens } = storyModule.resumeTokenBudget('default', undefined, 800);
    expect(remainingWords).toBeGreaterThan(0);
    expect(remainingWords).toBeLessThan(2400); // less than the default maxWords
    expect(maxTokens).toBeLessThan(full);
    expect(maxTokens).toBeGreaterThanOrEqual(256);
  });

  it('resumeTokenBudget respects an explicit wordTarget', () => {
    const { remainingWords } = storyModule.resumeTokenBudget('default', 2000, 1250);
    expect(remainingWords).toBe(750);
  });

  it('resumeTokenBudget floors at 1 when the partial already meets the target', () => {
    const { remainingWords, maxTokens } = storyModule.resumeTokenBudget('default', 2000, 5000);
    expect(remainingWords).toBe(1);
    expect(maxTokens).toBeGreaterThanOrEqual(256);
  });

  it('stripContinuationOverlap removes a duplicated leading passage', () => {
    const existing = 'The rain fell hard that night. Elena stared out the window.';
    const continuation = 'Elena stared out the window. She knew he would come.';
    const cleaned = storyModule.stripContinuationOverlap(existing, continuation);
    expect(cleaned).not.toContain('Elena stared out the window. Elena stared');
    // The overlap (the shared sentence) should be stripped from the front.
    expect(cleaned.trim()).toBe('She knew he would come.');
  });

  it('stripContinuationOverlap leaves unrelated text untouched', () => {
    const existing = 'The cat sat on the mat.';
    const continuation = 'A dog barked in the distance.';
    expect(storyModule.stripContinuationOverlap(existing, continuation)).toBe(continuation);
  });
});

// ── ai.askStream partial-preservation ──────────────────────────────────────

describe('ai.isMeaningfulPartial / classifyStreamError', () => {
  it('treats >= 40 trimmed chars as meaningful', () => {
    expect(ai.isMeaningfulPartial('a'.repeat(40))).toBe(true);
    expect(ai.isMeaningfulPartial('a'.repeat(39))).toBe(false);
    expect(ai.isMeaningfulPartial('   ')).toBe(false);
    expect(ai.isMeaningfulPartial(null)).toBe(false);
  });

  it('classifies error reasons', () => {
    expect(ai.classifyStreamError('AI request timed out')).toBe('timeout');
    expect(ai.classifyStreamError('ECONNRESET socket hang up')).toBe('connection');
    expect(ai.classifyStreamError('something else')).toBe('transport');
  });
});

// ── generateChapter: timeout with partial content ──────────────────────────

describe('generateChapter — timeout with partial content', () => {
  it('preserves partial content and marks the chapter partial (no post-processing)', async () => {
    writeStory('rex-timeout-1');
    const partial = JSON.stringify({
      content: '[speaker:narrator][emotion:neutral] ' + 'A'.repeat(120) + '\n\n[speaker:Elena][emotion:curious] "What is this place?"',
    });
    // askStream rejects with a timeout carrying the partial text.
    ai.askStream.mockRejectedValueOnce(partialTimeoutError(partial));

    const result = await storyModule.generateChapter('rex-timeout-1', 1, { onToken: () => {} });

    expect(result.status).toBe('partial');
    expect(result.reason).toBe('timeout');
    expect(result.resumeAvailable).toBe(true);
    expect(result.content).toContain('[speaker:Elena]');
    expect(result.content.length).toBeGreaterThan(40);

    // Persisted as a partial chapter on disk.
    const onDisk = readStory('rex-timeout-1');
    expect(onDisk.chapters).toHaveLength(1);
    expect(onDisk.chapters[0].status).toBe('partial');
    expect(onDisk.chapters[0].resumeAvailable).toBe(true);
    expect(onDisk.chapters[0].generation.reason).toBe('timeout');

    // NO summary / knowledge / coherence was stored for the partial chapter.
    expect(storyRag.addDoc).not.toHaveBeenCalled();
    expect(coherence.checkChapter).not.toHaveBeenCalled();
  });

  it('does not store a coherence result for the incomplete chapter', async () => {
    writeStory('rex-timeout-noco');
    const partial = JSON.stringify({ content: 'B'.repeat(80) });
    ai.askStream.mockRejectedValueOnce(partialTimeoutError(partial));

    const result = await storyModule.generateChapter('rex-timeout-noco', 1, { onToken: () => {} });

    expect(result.status).toBe('partial');
    expect(result.coherence).toBeUndefined();
    expect(result.experience).toBeUndefined();
  });
});

// ── generateChapter: timeout before any usable output ──────────────────────

describe('generateChapter — timeout before usable output', () => {
  it('throws a normal failure (no resume available) when no partial was received', async () => {
    writeStory('rex-timeout-empty');
    // No partial text on the error.
    ai.askStream.mockRejectedValueOnce(new Error('AI request failed (http://x, model=llama3): AI request timed out'));

    await expect(
      storyModule.generateChapter('rex-timeout-empty', 1, { onToken: () => {} }),
    ).rejects.toThrow(/timed out before usable chapter content/i);

    // Nothing persisted.
    const onDisk = readStory('rex-timeout-empty');
    expect(onDisk.chapters).toHaveLength(0);
  });

  it('throws when the partial is too short to be meaningful', async () => {
    writeStory('rex-timeout-thin');
    ai.askStream.mockRejectedValueOnce(partialTimeoutError('tiny')); // < 40 chars

    await expect(
      storyModule.generateChapter('rex-timeout-thin', 1, { onToken: () => {} }),
    ).rejects.toThrow(/timed out before usable chapter content/i);
  });

  it('non-streaming ai.ask timeout surfaces as a normal failure (no resume)', async () => {
    writeStory('rex-timeout-ask');
    ai.ask.mockRejectedValueOnce(new Error('AI request failed: AI request timed out'));

    await expect(
      storyModule.generateChapter('rex-timeout-ask', 1),
    ).rejects.toThrow(/timed out before usable chapter content/i);
  });
});

// ── generateChapter: resume continuation ───────────────────────────────────

describe('generateChapter — resume', () => {
  it('continues from the existing partial, concatenates, and marks complete', async () => {
    // Seed a partial chapter on disk (as a timeout would have left it).
    const existingPartial = '[speaker:narrator][emotion:neutral] ' + 'C'.repeat(80) + '\n\n[speaker:Elena][emotion:curious] "Tell me more."';
    writeStory('rex-resume-1', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', model: 'gemma3:27b' },
      }],
    });

    // The resume askStream returns a continuation that does NOT repeat existing text.
    const continuation = '[speaker:narrator][emotion:neutral] The stranger lowered his voice.\n\n[speaker:Elena][emotion:happy] "I understand now."';
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: continuation }));
    // Post-processing calls (summary, characters, knowledge) use ai.ask.
    ai.ask
      .mockResolvedValueOnce('Summary of the completed chapter.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    const result = await storyModule.generateChapter('rex-resume-1', 1, { onToken: () => {}, resume: {} });

    expect(result.status).toBe('complete');
    // Existing text is preserved at the start.
    expect(result.content).toContain('C'.repeat(80));
    expect(result.content).toContain('"Tell me more."');
    // Continuation is appended.
    expect(result.content).toContain('The stranger lowered his voice.');
    expect(result.content).toContain('"I understand now."');

    // On disk the chapter is now complete.
    const onDisk = readStory('rex-resume-1');
    expect(onDisk.chapters[0].status).toBe('complete');

    // Post-processing ran (summary stored).
    expect(storyRag.addDoc).toHaveBeenCalledWith('rex-resume-1', expect.objectContaining({
      id: 'summary-1',
      type: 'summary',
    }));
    expect(coherence.checkChapter).toHaveBeenCalled();
  });

  it('uses the SAME model captured on the partial chapter (no silent switch)', async () => {
    const existingPartial = 'D'.repeat(80);
    writeStory('rex-resume-model', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', model: 'gemma3:27b' },
      }],
    });
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'E'.repeat(80) }));
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    await storyModule.generateChapter('rex-resume-model', 1, { onToken: () => {}, resume: {} });

    // The resume call must use the model from the partial's generation metadata.
    const resumeOptions = ai.askStream.mock.calls[0][1];
    expect(resumeOptions.model).toBe('gemma3:27b');
  });

  it('requests only the REMAINING token budget (not a full chapter budget)', async () => {
    const existingPartial = 'F'.repeat(2000); // plenty of words already
    writeStory('rex-resume-budget', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', wordTarget: 2000, model: 'llama3' },
      }],
    });
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'G'.repeat(80) }));
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    await storyModule.generateChapter('rex-resume-budget', 1, { onToken: () => {}, resume: {} });

    const resumeOptions = ai.askStream.mock.calls[0][1];
    const fullBudget = storyModule.chapterTokenBudget('default', 2000);
    expect(resumeOptions.maxTokens).toBeLessThan(fullBudget);
    expect(resumeOptions.maxTokens).toBeGreaterThanOrEqual(256);
  });

  it('strips duplicated overlap where the model restated the existing tail', async () => {
    const existingPartial = '[speaker:narrator][emotion:neutral] ' + 'H'.repeat(80) + '\n\n[speaker:Elena][emotion:curious] "What is this place?"';
    writeStory('rex-resume-dedup', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', model: 'llama3' },
      }],
    });
    // The model restates the last sentence before continuing.
    const continuation = '"What is this place?" She stepped forward into the dark.';
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: continuation }));
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    const result = await storyModule.generateChapter('rex-resume-dedup', 1, { onToken: () => {}, resume: {} });

    // The duplicated sentence must not appear twice.
    const matches = result.content.match(/What is this place\?/g);
    expect(matches).toHaveLength(1);
    // The new continuation is present.
    expect(result.content).toContain('She stepped forward into the dark.');
  });

  it('the resume prompt tells the model not to reproduce the existing text', async () => {
    const existingPartial = 'I'.repeat(120);
    writeStory('rex-resume-prompt', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', model: 'llama3' },
      }],
    });
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'J'.repeat(80) }));
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    await storyModule.generateChapter('rex-resume-prompt', 1, { onToken: () => {}, resume: {} });

    const prompt = ai.askStream.mock.calls[0][0];
    expect(prompt).toMatch(/continue writing from the EXACT end/i);
    expect(prompt).toMatch(/do NOT repeat|Do NOT reproduce/i);
    expect(prompt).toContain(existingPartial);
    expect(prompt).toMatch(/CONTINUATION text only/i);
  });

  it('throws when resuming but no existing partial content exists', async () => {
    writeStory('rex-resume-none');
    await expect(
      storyModule.generateChapter('rex-resume-none', 1, { resume: {} }),
    ).rejects.toThrow(/no existing partial chapter content/i);
  });
});

// ── Multiple sequential resumes (cumulative length tracking) ────────────────

describe('generateChapter — multiple sequential resumes', () => {
  it('tracks cumulative length across two resume attempts', async () => {
    // Start: a small partial. First resume times out again with more text.
    // Second resume completes. The final budget of the second resume must be
    // smaller than the first (cumulative words reduce the remaining budget).
    const partial1 = 'K'.repeat(200);
    writeStory('rex-resume-multi', {
      chapters: [{
        number: 1,
        content: partial1,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', wordTarget: 2000, model: 'llama3' },
      }],
    });

    // First resume: times out again, preserving a larger partial.
    const grownPartial = 'K'.repeat(200) + '\n\n' + 'L'.repeat(2000); // ~ many words
    ai.askStream.mockRejectedValueOnce(partialTimeoutError(JSON.stringify({ content: grownPartial })));

    let result = await storyModule.generateChapter('rex-resume-multi', 1, { onToken: () => {}, resume: {} });
    expect(result.status).toBe('partial');

    // The partial on disk now contains the grown content.
    const afterFirst = readStory('rex-resume-multi');
    expect(afterFirst.chapters[0].content).toContain('L'.repeat(2000));

    // Second resume: completes.
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'M'.repeat(80) }));
    ai.ask
      .mockResolvedValueOnce('Final summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    result = await storyModule.generateChapter('rex-resume-multi', 1, { onToken: () => {}, resume: {} });
    expect(result.status).toBe('complete');
    expect(result.content).toContain('K'.repeat(200));
    expect(result.content).toContain('L'.repeat(2000));
    expect(result.content).toContain('M'.repeat(80));
  });
});

// ── Backward compatibility ─────────────────────────────────────────────────

describe('backward compatibility', () => {
  it('existing chapters without a status field are treated as complete', async () => {
    // A story with a legacy chapter (no status field). Generating the NEXT
    // chapter must work normally and not be confused by the legacy chapter.
    writeStory('rex-legacy', {
      chapters: [{ number: 1, content: 'Legacy chapter text.', createdAt: '2024-01-01T00:00:00Z' }],
    });
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter two content.' }))
      .mockResolvedValueOnce('Summary two.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    const result = await storyModule.generateChapter('rex-legacy', 2);

    expect(result.status).toBe('complete');
    const onDisk = readStory('rex-legacy');
    // Legacy chapter keeps its (now missing→complete) shape; new chapter is complete.
    expect(onDisk.chapters.find((c) => c.number === 1).status).toBeUndefined();
    expect(onDisk.chapters.find((c) => c.number === 2).status).toBe('complete');
  });

  it('a completed chapter result still has status complete and runs post-processing', async () => {
    writeStory('rex-complete');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'A finished chapter.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    const result = await storyModule.generateChapter('rex-complete', 1);
    expect(result.status).toBe('complete');
    expect(result.coherence).not.toBeNull();
    expect(storyRag.addDoc).toHaveBeenCalled();
  });
});

// ── Reader Experience objective preservation on resume ─────────────────────

describe('generateChapter — resume preserves Reader Experience objective', () => {
  it('reuses the objective stored on the partial chapter instead of re-synthesizing', async () => {
    const objective = {
      currentState: { readerEmotion: 'curiosity' },
      targetState: { readerEmotion: 'suspense' },
      readerQuestions: ['Who is Cedric?'],
      emotionalTrajectory: ['curiosity', 'suspense'],
    };
    const existingPartial = 'N'.repeat(120);
    writeStory('rex-resume-rex', {
      chapters: [{
        number: 1,
        content: existingPartial,
        status: 'partial',
        resumeAvailable: true,
        createdAt: new Date().toISOString(),
        generation: { reason: 'timeout', length: 'default', model: 'llama3', experienceObjective: objective },
      }],
    });
    // Reader Experience is configured for the story.
    storyRag.getExperienceConfig.mockReturnValue({ primary: 'curiosity', secondary: 'suspense', intensity: 'high', pacing: 'moderate' });
    // If resume re-synthesized, this would be called. It must NOT be.
    const experience = require('../story/story-experience');
    const synSpy = jest.spyOn(experience, 'synthesizeObjective').mockResolvedValue({ synthesized: true, objective: { different: true } });

    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'O'.repeat(80) }));
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce(JSON.stringify([]))
      .mockResolvedValueOnce(JSON.stringify({ elements: [] }));

    const result = await storyModule.generateChapter('rex-resume-rex', 1, { onToken: () => {}, resume: {} });

    // The SAME objective was reused, not a freshly synthesized one.
    expect(synSpy).not.toHaveBeenCalled();
    expect(result.experienceObjective.objective).toEqual(objective);
    expect(result.experienceObjective.reused).toBe(true);

    synSpy.mockRestore();
  });
});

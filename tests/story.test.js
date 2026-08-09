'use strict';

// Mock ai.js so no real HTTP calls are made
jest.mock('../lib/ai');
// Mock story-rag.js so tests do not touch the filesystem for RAG docs
jest.mock('../story/story-rag');

const path = require('path');
const fs = require('fs');
const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const storyModule = require('../story/story');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

/**
 * Remove only the story `.json` files written by story.test.js from STORIES_DIR.
 * Subdirectories (per-story RAG dirs that story-rag.js creates at runtime) are
 * NOT removed here for two reasons:
 *   1. story.js tests mock `story-rag`, so no real subdirectories are created
 *      during these tests.
 *   2. Jest runs test files in parallel workers sharing the same filesystem, so
 *      unconditionally removing subdirectories could race with story-rag.test.js
 *      which owns and manages those directories through its own beforeEach/afterEach.
 */
function cleanupStoriesDir() {
  if (!fs.existsSync(STORIES_DIR)) return;
  for (const entry of fs.readdirSync(STORIES_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.unlinkSync(path.join(STORIES_DIR, entry.name));
    }
  }
}

afterEach(() => {
  jest.clearAllMocks();
  cleanupStoriesDir();
});

describe('story.js — create()', () => {
  it('returns a story object with expected fields', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Act 1: setup. Act 2: conflict. Act 3: resolution.' }));

    const result = await storyModule.create('Lost City', 'adventure', 'epic');

    expect(result).toHaveProperty('id');
    expect(result.title).toBe('Lost City');
    expect(result.genre).toBe('adventure');
    expect(result.tone).toBe('epic');
    expect(result.outline).toBe('Act 1: setup. Act 2: conflict. Act 3: resolution.');
    expect(result).toHaveProperty('createdAt');
  });

  it('saves the story as a JSON file in the stories directory', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'A thrilling tale.' }));

    const result = await storyModule.create('Shadow Run', 'thriller', 'dark');

    const filePath = path.join(STORIES_DIR, `${result.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.title).toBe('Shadow Run');
    expect(saved.outline).toBe('A thrilling tale.');
  });

  it('generates a unique id that includes the slugified title', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Some outline.' }));

    const result = await storyModule.create('My Great Novel', 'drama', 'serious');

    expect(result.id).toMatch(/my-great-novel/);
  });

  it('falls back to raw AI response when no JSON is found', async () => {
    ai.ask.mockResolvedValue('Chapter 1: The beginning.\nChapter 2: The middle.');

    const result = await storyModule.create('Raw Story', 'fiction', 'light');

    expect(result.outline).toBe('Chapter 1: The beginning.\nChapter 2: The middle.');
  });

  it('falls back to raw response when JSON lacks an outline field', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ something: 'else' }));

    const result = await storyModule.create('No Outline', 'mystery', 'tense');

    expect(result.outline).toBe(JSON.stringify({ something: 'else' }));
  });

  it('falls back to raw response when JSON is malformed', async () => {
    ai.ask.mockResolvedValue('{broken json,,,}');

    const result = await storyModule.create('Broken', 'sci-fi', 'cold');

    expect(result.outline).toBe('{broken json,,,}');
  });

  it('passes aiOptions through to ai.ask', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Short outline.' }));

    await storyModule.create('Option Test', 'romance', 'warm', { model: 'mistral' });

    expect(ai.ask).toHaveBeenCalledWith(expect.any(String), { model: 'mistral' });
  });

  it('streams the outline via ai.askStream when onToken is provided', async () => {
    ai.askStream.mockResolvedValue(JSON.stringify({ outline: 'Streamed outline.' }));

    const tokens = [];
    const result = await storyModule.create('Streamed', 'fantasy', 'epic', {
      model: 'mistral',
      onToken: (t) => tokens.push(t),
      onPhase: () => {},
    });

    expect(ai.askStream).toHaveBeenCalled();
    expect(ai.ask).not.toHaveBeenCalled();
    expect(result.outline).toBe('Streamed outline.');
  });

  it('builds a prompt that includes the title, genre, and tone', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Details here.' }));

    await storyModule.create('Dragon Realm', 'fantasy', 'epic');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Dragon Realm');
    expect(prompt).toContain('fantasy');
    expect(prompt).toContain('epic');
  });

  it('propagates errors thrown by ai.ask', async () => {
    ai.ask.mockRejectedValue(new Error('AI unavailable'));

    await expect(storyModule.create('Fail', 'genre', 'tone')).rejects.toThrow('AI unavailable');
  });

  it('stores a valid ISO 8601 createdAt timestamp', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Timeline outline.' }));

    const result = await storyModule.create('Time Story', 'historical', 'solemn');

    expect(() => new Date(result.createdAt)).not.toThrow();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });

  it('stores initial characters in the RAG store when AI returns them', async () => {
    storyRag.addDoc.mockImplementation(() => {});
    ai.ask.mockResolvedValue(JSON.stringify({
      outline: 'A hero journeys forth.',
      characters: [
        { name: 'Aria', role: 'protagonist', gender: 'female', personality: 'brave, curious', backstory: 'A young knight seeking justice.' },
        { name: 'Mord', role: 'villain', gender: 'male', personality: 'cunning, ruthless', backstory: 'A warlord driven by greed.' },
      ],
      locations: [],
    }));

    const result = await storyModule.create('World Test', 'fantasy', 'epic');

    const charCalls = storyRag.addDoc.mock.calls.filter(([, doc]) => doc.type === 'character');
    expect(charCalls).toHaveLength(2);
    expect(charCalls[0][0]).toBe(result.id);
    expect(charCalls[0][1]).toMatchObject({ id: 'char-aria', type: 'character', name: 'Aria', role: 'protagonist', gender: 'female' });
    expect(charCalls[1][1]).toMatchObject({ id: 'char-mord', type: 'character', name: 'Mord', role: 'villain', gender: 'male' });
  });

  it('stores initial locations as lore entries in the RAG store when AI returns them', async () => {
    storyRag.addDoc.mockImplementation(() => {});
    ai.ask.mockResolvedValue(JSON.stringify({
      outline: 'Two kingdoms clash.',
      characters: [],
      locations: [
        { title: 'Iron Keep', description: 'A fortress on a frozen cliff.' },
        { title: 'The Sunken Market', description: 'An underground bazaar shrouded in mist.' },
      ],
    }));

    const result = await storyModule.create('Lore Test', 'fantasy', 'dark');

    const loreCalls = storyRag.addDoc.mock.calls.filter(([, doc]) => doc.type === 'lore');
    expect(loreCalls).toHaveLength(2);
    expect(loreCalls[0][0]).toBe(result.id);
    expect(loreCalls[0][1]).toMatchObject({ id: 'lore-iron-keep', type: 'lore', title: 'Iron Keep' });
    expect(loreCalls[1][1]).toMatchObject({ id: 'lore-the-sunken-market', type: 'lore', title: 'The Sunken Market' });
  });

  it('does not call addDoc when AI returns no characters or locations', async () => {
    storyRag.addDoc.mockImplementation(() => {});
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Minimal outline.' }));

    await storyModule.create('Minimal', 'drama', 'calm');

    expect(storyRag.addDoc).not.toHaveBeenCalled();
  });

  it('assigns a voice preset to each initial character', async () => {
    storyRag.addDoc.mockImplementation(() => {});
    ai.ask.mockResolvedValue(JSON.stringify({
      outline: 'An adventure begins.',
      characters: [{ name: 'Lily', role: 'hero', gender: 'female', personality: 'young, energetic', backstory: '' }],
      locations: [],
    }));

    await storyModule.create('Voice Test', 'adventure', 'light');

    const charCall = storyRag.addDoc.mock.calls.find(([, doc]) => doc.type === 'character');
    expect(charCall[1].voiceId).toBe('preset-young-girl');
  });

  it('ignores characters with missing or empty names', async () => {
    storyRag.addDoc.mockImplementation(() => {});
    ai.ask.mockResolvedValue(JSON.stringify({
      outline: 'Some outline.',
      characters: [
        { name: '', role: 'unknown' },
        { role: 'side' },
        { name: 'Valid', role: 'hero', gender: 'male', personality: 'brave', backstory: '' },
      ],
      locations: [],
    }));

    await storyModule.create('Name Filter', 'mystery', 'tense');

    const charCalls = storyRag.addDoc.mock.calls.filter(([, doc]) => doc.type === 'character');
    expect(charCalls).toHaveLength(1);
    expect(charCalls[0][1].name).toBe('Valid');
  });

  it('includes characters and locations request in the prompt', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Details here.' }));

    await storyModule.create('Prompt Check', 'fantasy', 'epic');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('"characters"');
    expect(prompt).toContain('"locations"');
  });

  it('appends customPrompt to the outline prompt when provided', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Outline.' }));

    await storyModule.create('Custom Story', 'fantasy', 'epic', {}, 'Include a heist subplot.');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Additional instructions: Include a heist subplot.');
  });

  it('omits the additional-instructions block when customPrompt is empty', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Outline.' }));

    await storyModule.create('No Custom', 'fantasy', 'epic', {}, '   ');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).not.toMatch(/Additional instructions/);
  });
});

// ── story.js — generateChapter() ────────────────────────────────────────────

describe('story.js — generateChapter()', () => {
  /**
   * Helper: write a minimal story JSON file so generateChapter can load it.
   */
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

  beforeEach(() => {
    // Default: no characters, no lore, no summaries
    storyRag.listDocs.mockReturnValue([]);
    storyRag.addDoc.mockImplementation(() => {});
    storyRag.removeDoc.mockReturnValue(true);
  });

  it('returns the generated chapter with storyId and chapterNumber', async () => {
    writeStory('test-1234');
    // First call → chapter content; second call → chapter summary
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter one begins.' }))
      .mockResolvedValueOnce('Elena arrived at the tower.');

    const result = await storyModule.generateChapter('test-1234', 1);

    expect(result.storyId).toBe('test-1234');
    expect(result.chapterNumber).toBe(1);
    expect(result.content).toBe('Chapter one begins.');
  });

  it('saves the chapter to the story JSON file', async () => {
    writeStory('test-save-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Saved chapter content.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-save-1234', 1);

    const saved = JSON.parse(
      fs.readFileSync(path.join(STORIES_DIR, 'test-save-1234.json'), 'utf8'),
    );
    expect(saved.chapters).toHaveLength(1);
    expect(saved.chapters[0].content).toBe('Saved chapter content.');
  });

  it('throws when the story file does not exist', async () => {
    await expect(
      storyModule.generateChapter('nonexistent-story', 1),
    ).rejects.toThrow('Story not found');
  });

  it('injects character context into the prompt when characters are defined', async () => {
    writeStory('test-char-1234');
    storyRag.listDocs.mockImplementation((storyId, type) => {
      if (type === 'character') {
        return [{
          id: 'char-elena',
          type: 'character',
          name: 'Elena',
          role: 'protagonist',
          gender: 'female',
          personality: 'curious',
          backstory: 'A former detective.',
          speechStyle: 'formal',
          voiceId: 'elena_voice',
          content: 'Name: Elena. Role: protagonist.',
        }];
      }
      return [];
    });

    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Elena enters.' }))
      .mockResolvedValueOnce('Elena entered the room.');

    await storyModule.generateChapter('test-char-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Cast of Characters');
    expect(prompt).toContain('Elena');
    expect(prompt).toContain('protagonist');
    expect(prompt).toContain('[speaker:Elena]');
  });

  it('injects lore context into the prompt when lore entries are defined', async () => {
    writeStory('test-lore-1234');
    storyRag.listDocs.mockImplementation((storyId, type) => {
      if (type === 'lore') {
        return [{
          id: 'lore-shadowfall',
          type: 'lore',
          title: 'Shadowfall City',
          content: 'A crumbling metropolis at the edge of the Waste.',
        }];
      }
      return [];
    });

    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'The city loomed.' }))
      .mockResolvedValueOnce('The hero arrived at the city gates.');

    await storyModule.generateChapter('test-lore-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('World Context');
    expect(prompt).toContain('Shadowfall City');
    expect(prompt).toContain('crumbling metropolis');
  });

  it('uses chapter summaries as prior context when they exist', async () => {
    writeStory('test-summary-1234');
    storyRag.listDocs.mockImplementation((storyId, type) => {
      if (type === 'summary') {
        return [{ id: 'summary-1', type: 'summary', chapterNumber: 1, content: 'Elena arrived.' }];
      }
      return [];
    });

    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter 2 content.' }))
      .mockResolvedValueOnce('Elena explored further.');

    await storyModule.generateChapter('test-summary-1234', 2);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Chapter 1 Summary');
    expect(prompt).toContain('Elena arrived');
  });

  it('stores a chapter summary in the story RAG store after generation', async () => {
    writeStory('test-store-summary-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter content.' }))
      .mockResolvedValueOnce('The hero defeated the villain.');

    await storyModule.generateChapter('test-store-summary-1234', 1);

    expect(storyRag.addDoc).toHaveBeenCalledWith('test-store-summary-1234', expect.objectContaining({
      id: 'summary-1',
      type: 'summary',
      chapterNumber: 1,
      content: 'The hero defeated the villain.',
    }));
  });

  it('does not fail chapter generation when summary AI call throws', async () => {
    writeStory('test-summary-err-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter content.' }))
      .mockRejectedValueOnce(new Error('AI timeout'));

    // Chapter generation should still succeed even if summary fails.
    await expect(
      storyModule.generateChapter('test-summary-err-1234', 1),
    ).resolves.toHaveProperty('content', 'Chapter content.');
  });

  it('passes aiOptions to chapter, summary, and knowledge extraction calls', async () => {
    writeStory('test-opts-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter content.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce('{"extractions":[]}');

    await storyModule.generateChapter('test-opts-1234', 1, { model: 'mistral' });

    expect(ai.ask).toHaveBeenCalledTimes(3);
    // Chapter call gets a length-sized token budget added on top of aiOptions.
    expect(ai.ask).toHaveBeenNthCalledWith(1, expect.any(String), {
      model: 'mistral',
      maxTokens: storyModule.chapterTokenBudget('default'),
    });
    // Summary and knowledge extraction calls pass the original aiOptions unchanged.
    expect(ai.ask).toHaveBeenNthCalledWith(2, expect.any(String), { model: 'mistral' });
    expect(ai.ask).toHaveBeenNthCalledWith(3, expect.any(String), { model: 'mistral' });
  });

  it('streams the chapter via ai.askStream when onToken is provided', async () => {
    writeStory('test-stream-1234');
    ai.askStream.mockResolvedValueOnce(JSON.stringify({ content: 'Streamed chapter.' }));
    // Post-generation steps still use ai.ask (mocked).
    ai.ask
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce('{"extractions":[]}');

    const phases = [];
    const result = await storyModule.generateChapter('test-stream-1234', 1, {
      onToken: () => {},
      onPhase: (p) => phases.push(p),
    });

    expect(ai.askStream).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('Streamed chapter.');
    // Phases are emitted around each step.
    expect(phases).toContain('Writing chapter');
    expect(phases).toContain('Done');
  });

  it('builds a coherence-guided regeneration prompt when regenerate is set', async () => {
    // Pre-existing chapter to regenerate (so its original content is referenced).
    writeStory('test-regen-1234', {
      chapters: [{ number: 1, content: 'Kael panicked and froze.', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Kael reacted calmly and tested the ability.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce('{"extractions":[]}');

    await storyModule.generateChapter('test-regen-1234', 1, {
      regenerate: {
        evidence: 'Kael\'s power activation contradicts his established fear.',
        recommendation: 'Have Kael react calmly and test the new ability.',
        customInstruction: 'Keep the dialogue minimal.',
      },
    });

    const prompt = ai.ask.mock.calls[0][0];
    // Regeneration framing, not the generic "write" framing.
    expect(prompt).toMatch(/Regenerate/);
    // The three coherence inputs are all present in the prompt.
    expect(prompt).toContain('Kael\'s power activation contradicts his established fear.');
    expect(prompt).toContain('Have Kael react calmly and test the new ability.');
    expect(prompt).toContain('Keep the dialogue minimal.');
    // Original chapter content is referenced for preservation.
    expect(prompt).toContain('Kael panicked and froze.');
    // The custom instruction is framed as an ADDITIONAL constraint, not a replacement.
    expect(prompt).toMatch(/do NOT ignore the coherence correction/i);
  });

  it('regenerates using the recommendation alone when customInstruction is empty', async () => {
    writeStory('test-regen-no-custom-1234', {
      chapters: [{ number: 1, content: 'Original text.', createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Fixed chapter.' }))
      .mockResolvedValueOnce('Summary.')
      .mockResolvedValueOnce('{"extractions":[]}');

    await storyModule.generateChapter('test-regen-no-custom-1234', 1, {
      regenerate: {
        evidence: 'Evidence here.',
        recommendation: 'Fix recommendation.',
        customInstruction: '',
      },
    });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Evidence here.');
    expect(prompt).toContain('Fix recommendation.');
    // No "Also apply the following user instruction" block when empty.
    expect(prompt).not.toMatch(/Also apply the following user instruction/);
  });

  it('preserves the original chapter on generation failure', async () => {
    const original = 'Kael panicked and froze.';
    writeStory('test-regen-fail-1234', {
      chapters: [{ number: 1, content: original, createdAt: '2024-01-01T00:00:00.000Z' }],
    });
    ai.ask.mockRejectedValueOnce(new Error('AI offline'));

    await expect(storyModule.generateChapter('test-regen-fail-1234', 1, {
      regenerate: { evidence: 'e', recommendation: 'r' },
    })).rejects.toThrow('AI offline');

    // The on-disk chapter is unchanged because the write only happens on success.
    const saved = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, 'test-regen-fail-1234.json'), 'utf8'));
    expect(saved.chapters[0].content).toBe(original);
  });
});

// ── story.js — deleteChapter() ───────────────────────────────────────────────

describe('story.js — deleteChapter()', () => {
  function writeStory(id, chapters = []) {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({
        id,
        title: 'T',
        genre: 'g',
        tone: 't',
        outline: 'o',
        createdAt: new Date().toISOString(),
        chapters,
      }, null, 2),
      'utf8',
    );
  }

  beforeEach(() => {
    storyRag.removeDoc.mockReturnValue(true);
  });

  it('removes the chapter summary from the RAG store', async () => {
    writeStory('del-ch-1234', [{ number: 1, content: 'Content.', createdAt: new Date().toISOString() }]);

    await storyModule.deleteChapter('del-ch-1234', 1);

    expect(storyRag.removeDoc).toHaveBeenCalledWith('del-ch-1234', 'summary-1');
  });

  it('throws when the story does not exist', async () => {
    await expect(storyModule.deleteChapter('no-story', 1)).rejects.toThrow('Story not found');
  });

  it('throws when the chapter does not exist', async () => {
    writeStory('del-ch-miss-1234', []);
    await expect(storyModule.deleteChapter('del-ch-miss-1234', 99)).rejects.toThrow('Chapter 99 not found');
  });
});

// ── story.js — deleteStory() ─────────────────────────────────────────────────

describe('story.js — deleteStory()', () => {
  beforeEach(() => {
    storyRag.clearStory.mockImplementation(() => {});
  });

  it('deletes the story JSON file and clears the story RAG docs', () => {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
    const id = 'del-story-1234';
    fs.writeFileSync(
      path.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({ id, title: 'T', genre: 'g', tone: 't', outline: 'o', createdAt: new Date().toISOString() }),
      'utf8',
    );

    storyModule.deleteStory(id);

    expect(fs.existsSync(path.join(STORIES_DIR, `${id}.json`))).toBe(false);
    expect(storyRag.clearStory).toHaveBeenCalledWith(id);
  });

  it('throws when the story does not exist', () => {
    expect(() => storyModule.deleteStory('ghost-story')).toThrow('Story not found');
  });
});

// ── story.js — updateChapterContent() ────────────────────────────────────────

describe('story.js — updateChapterContent()', () => {
  function writeStory(id, chapters = []) {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({
        id,
        title: 'T',
        genre: 'g',
        tone: 't',
        outline: 'o',
        createdAt: new Date().toISOString(),
        chapters,
      }, null, 2),
      'utf8',
    );
  }

  it('updates the content of an existing chapter and returns the result', () => {
    const id = 'upd-ch-1234';
    writeStory(id, [{ number: 1, content: 'Old content.', createdAt: new Date().toISOString() }]);

    const result = storyModule.updateChapterContent(id, 1, '[speaker:narrator] New content.');

    expect(result.storyId).toBe(id);
    expect(result.chapterNumber).toBe(1);
    expect(result.content).toBe('[speaker:narrator] New content.');

    // Verify persisted on disk
    const saved = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, `${id}.json`), 'utf8'));
    expect(saved.chapters[0].content).toBe('[speaker:narrator] New content.');
    // number and createdAt must be preserved
    expect(saved.chapters[0].number).toBe(1);
    expect(saved.chapters[0].createdAt).toBeDefined();
  });

  it('throws when the story does not exist', () => {
    expect(() => storyModule.updateChapterContent('no-story', 1, 'content')).toThrow('Story not found');
  });

  it('throws when the chapter does not exist', () => {
    const id = 'upd-ch-miss-1234';
    writeStory(id, []);
    expect(() => storyModule.updateChapterContent(id, 99, 'content')).toThrow('Chapter 99 not found');
  });
});

// ── story.js — _extractNewCharacters() (via generateChapter) ────────────────

describe('story.js — auto-character extraction (via generateChapter)', () => {
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

  beforeEach(() => {
    storyRag.listDocs.mockReturnValue([]);
    storyRag.addDoc.mockImplementation(() => {});
    storyRag.removeDoc.mockReturnValue(true);
  });

  it('auto-creates a character profile for a named speaker in chapter content', async () => {
    writeStory('test-char-extract-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Elena][emotion:neutral] She walked in.' }))
      .mockResolvedValueOnce('Elena walked in.')
      .mockResolvedValueOnce(JSON.stringify({ role: 'protagonist', gender: 'female', personality: 'brave' }));

    await storyModule.generateChapter('test-char-extract-1234', 1);

    expect(storyRag.addDoc).toHaveBeenCalledWith('test-char-extract-1234', expect.objectContaining({
      type:        'character',
      name:        'Elena',
      role:        'protagonist',
      gender:      'female',
      personality: 'brave',
      voiceId:     'preset-adult-female',
    }));
  });

  it('skips generic speakers (narrator, male, female)', async () => {
    writeStory('test-generic-speakers-1234');
    ai.ask
      .mockResolvedValueOnce(
        JSON.stringify({ content: '[speaker:narrator] Narration. [speaker:male] Male line. [speaker:female] Female line.' }),
      )
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-generic-speakers-1234', 1);

    // Only the summary addDoc call — no character addDoc calls
    expect(storyRag.addDoc).toHaveBeenCalledTimes(1);
    expect(storyRag.addDoc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'summary' }),
    );
  });

  it('skips characters that already exist in the RAG store', async () => {
    writeStory('test-skip-existing-1234');
    storyRag.listDocs.mockImplementation((_, type) => {
      if (type === 'character') {
        return [{ id: 'char-elena', name: 'Elena', type: 'character', voiceId: 'my_voice' }];
      }
      return [];
    });

    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Elena] She smiled.' }))
      .mockResolvedValueOnce('Elena smiled.');

    await storyModule.generateChapter('test-skip-existing-1234', 1);

    // Only the summary addDoc, no character addDoc
    expect(storyRag.addDoc).toHaveBeenCalledTimes(1);
    expect(storyRag.addDoc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: 'summary' }),
    );
  });

  it('does not fail chapter generation when character AI call throws', async () => {
    writeStory('test-char-extract-err-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Marcus] He arrived.' }))
      .mockResolvedValueOnce('Marcus arrived.')
      .mockRejectedValueOnce(new Error('AI timeout'));

    await expect(
      storyModule.generateChapter('test-char-extract-err-1234', 1),
    ).resolves.toHaveProperty('content');
  });

  it('assigns the correct voice preset based on gender and personality', async () => {
    writeStory('test-voice-preset-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Tommy] Hey!' }))
      .mockResolvedValueOnce('Tommy spoke.')
      .mockResolvedValueOnce(JSON.stringify({ role: 'sidekick', gender: 'male', personality: 'young, energetic' }));

    await storyModule.generateChapter('test-voice-preset-1234', 1);

    expect(storyRag.addDoc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ voiceId: 'preset-young-boy' }),
    );
  });

  it('passes aiOptions to the character-description AI call', async () => {
    writeStory('test-char-opts-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Zara] Hi there!' }))
      .mockResolvedValueOnce('Zara spoke.')
      .mockResolvedValueOnce(JSON.stringify({ role: 'hero', gender: 'female', personality: 'bold' }));

    await storyModule.generateChapter('test-char-opts-1234', 1, { model: 'mistral' });

    // Call 3 is the character-description call
    expect(ai.ask).toHaveBeenNthCalledWith(3, expect.any(String), { model: 'mistral' });
  });

  it('does not duplicate a character seen multiple times in the same chapter', async () => {
    writeStory('test-dedup-speakers-1234');
    ai.ask
      .mockResolvedValueOnce(
        JSON.stringify({ content: '[speaker:Aria] First. [speaker:Aria] Second.' }),
      )
      .mockResolvedValueOnce('Aria spoke twice.')
      // Only one character-description call expected
      .mockResolvedValueOnce(JSON.stringify({ role: 'hero', gender: 'female', personality: 'brave' }));

    await storyModule.generateChapter('test-dedup-speakers-1234', 1);

    const charCalls = storyRag.addDoc.mock.calls.filter(
      ([, doc]) => doc.type === 'character',
    );
    expect(charCalls).toHaveLength(1);
    expect(charCalls[0][1]).toMatchObject({ name: 'Aria' });
  });
});

// ── story.js — pickVoicePreset() ─────────────────────────────────────────────

describe('story.js — pickVoicePreset()', () => {
  it('returns preset-adult-female for female gender with no age hint', () => {
    expect(storyModule.pickVoicePreset('female', '')).toBe('preset-adult-female');
  });

  it('returns preset-young-girl for female gender with young keyword', () => {
    expect(storyModule.pickVoicePreset('female', 'young, curious')).toBe('preset-young-girl');
  });

  it('returns preset-elderly-female for female gender with elderly keyword', () => {
    expect(storyModule.pickVoicePreset('female', 'elderly, wise')).toBe('preset-elderly-female');
  });

  it('returns preset-adult-male for male gender with no age hint', () => {
    expect(storyModule.pickVoicePreset('male', '')).toBe('preset-adult-male');
  });

  it('returns preset-young-boy for male gender with child keyword', () => {
    expect(storyModule.pickVoicePreset('male', 'child, playful')).toBe('preset-young-boy');
  });

  it('returns preset-elderly-male for male gender with senior keyword', () => {
    expect(storyModule.pickVoicePreset('male', 'senior, stoic')).toBe('preset-elderly-male');
  });

  it('returns preset-adult-male as default for unspecified gender', () => {
    expect(storyModule.pickVoicePreset('', '')).toBe('preset-adult-male');
    expect(storyModule.pickVoicePreset(undefined, '')).toBe('preset-adult-male');
  });

  it('returns preset-young-girl for non-binary gender with young keyword', () => {
    expect(storyModule.pickVoicePreset('non-binary', 'teen, shy')).toBe('preset-young-girl');
  });
});

// ── story.js — normalizeChapterParagraphs() ────────────────────────────────

describe('story.js — normalizeChapterParagraphs()', () => {
  it('preserves content that already has double newlines', () => {
    const input = '[speaker:narrator][emotion:neutral] First paragraph.\n\n[speaker:Elena][emotion:happy] "Hello."';
    const result = storyModule.normalizeChapterParagraphs(input);
    expect(result).toContain('\n\n');
    expect(result).toContain('[speaker:narrator]');
    expect(result).toContain('[speaker:Elena]');
  });

  it('adds paragraph breaks for wall-of-text content with [speaker] tags', () => {
    const input = '[speaker:narrator][emotion:neutral] The sun rose over the hills. [speaker:Elena][emotion:happy] "Good morning!" [speaker:narrator][emotion:neutral] She smiled.';
    const result = storyModule.normalizeChapterParagraphs(input);
    expect(result).toContain('\n\n');
    expect(result).toContain('[speaker:narrator]');
    expect(result).toContain('[speaker:Elena]');
    expect(result).toContain('"Good morning!"');
  });

  it('does not invent story content when normalizing', () => {
    const input = '[speaker:narrator][emotion:neutral] A mysterious figure appeared.';
    const result = storyModule.normalizeChapterParagraphs(input);
    expect(result).toBe('[speaker:narrator][emotion:neutral] A mysterious figure appeared.');
  });

  it('normalizes multiple newlines to double newlines', () => {
    const input = '[speaker:narrator][emotion:neutral] First.\n\n\n\n[speaker:Elena][emotion:happy] Second.';
    const result = storyModule.normalizeChapterParagraphs(input);
    expect(result).not.toContain('\n\n\n');
    expect(result).toContain('\n\n');
  });

  it('handles null/undefined/empty input gracefully', () => {
    expect(storyModule.normalizeChapterParagraphs(null)).toBeNull();
    expect(storyModule.normalizeChapterParagraphs(undefined)).toBeUndefined();
    expect(storyModule.normalizeChapterParagraphs('')).toBe('');
  });

  it('preserves [speaker] tags exactly', () => {
    const input = '[speaker:Elena][emotion:curious] "What is that?"';
    const result = storyModule.normalizeChapterParagraphs(input);
    expect(result).toContain('[speaker:Elena][emotion:curious]');
  });

  it('splits content before each [speaker:X] tag', () => {
    const input = 'Intro text [speaker:Elena][emotion:happy] "Hello" [speaker:Marcus][emotion:neutral] "Hi there"';
    const result = storyModule.normalizeChapterParagraphs(input);
    const paragraphs = result.split('\n\n');
    expect(paragraphs.length).toBeGreaterThan(1);
    expect(result).toContain('[speaker:Elena]');
    expect(result).toContain('[speaker:Marcus]');
  });
});

// ── story.js — generateChapter formatting rules in prompt ─────────────────

describe('story.js — generateChapter prompt includes formatting rules', () => {
  function writeStory(id, data = {}) {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
    const defaults = {
      id,
      title: 'Test Story',
      genre: 'fantasy',
      tone: 'epic',
      outline: 'A hero journeys forth.',
      createdAt: new Date().toISOString(),
      chapters: [],
    };
    fs.writeFileSync(
      path.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({ ...defaults, ...data }, null, 2),
      'utf8',
    );
  }

  beforeEach(() => {
    storyRag.listDocs.mockReturnValue([]);
    storyRag.addDoc.mockImplementation(() => {});
    storyRag.removeDoc.mockReturnValue(true);
  });

  it('includes mandatory blank line formatting rules in chapter prompt', async () => {
    writeStory('test-prompt-format-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-prompt-format-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('MANDATORY FORMATTING RULES');
    expect(prompt).toContain('BLANK LINES BETWEEN PARAGRAPHS');
    expect(prompt).toContain('wall-of-text');
  });

  it('includes dialogue vs narration separation rules in chapter prompt', async () => {
    writeStory('test-prompt-dialogue-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-prompt-dialogue-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('DIALOGUE VS NARRATION SEPARATION');
  });

  it('includes required speaker/emotion tag rules in chapter prompt', async () => {
    writeStory('test-prompt-tags-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-prompt-tags-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('[speaker:');
    expect(prompt).toContain('[emotion:');
    expect(prompt).toContain('REQUIRED SPEAKER');
  });

  it('includes forbidden wall-of-text warning in chapter prompt', async () => {
    writeStory('test-prompt-wall-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-prompt-wall-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('FORBIDDEN');
    expect(prompt).toContain('SINGLE WALL-OF-TEXT');
  });

  it('wall-of-text chapter content gets paragraph breaks after normalization', async () => {
    writeStory('test-wall-text-1234');
    // AI returns a wall-of-text without paragraph breaks
    const wallOfText = '[speaker:narrator][emotion:neutral] The old house stood silent. [speaker:Elena][emotion:curious] "It looks abandoned." [speaker:narrator][emotion:neutral] She shivered.';
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: wallOfText }))
      .mockResolvedValueOnce('Summary.');

    const result = await storyModule.generateChapter('test-wall-text-1234', 1);

    expect(result.content).toContain('\n\n');
    expect(result.content).toContain('[speaker:narrator]');
    expect(result.content).toContain('[speaker:Elena]');
  });

  it('preserves [speaker] tags in normalized chapter content', async () => {
    writeStory('test-preserve-tags-1234');
    const messyContent = '[speaker:Elena][emotion:happy] "Hello" [speaker:Marcus][emotion:neutral] "Hi"';
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: messyContent }))
      .mockResolvedValueOnce('Summary.');

    const result = await storyModule.generateChapter('test-preserve-tags-1234', 1);

    expect(result.content).toContain('[speaker:Elena]');
    expect(result.content).toContain('[speaker:Marcus]');
    expect(result.content).toContain('[emotion:happy]');
    expect(result.content).toContain('[emotion:neutral]');
  });
});

// ── story.js — buildLengthPolicy() ────────────────────────────────────────

describe('story.js — buildLengthPolicy()', () => {
  it('returns correct policy for short preset', () => {
    const policy = storyModule.buildLengthPolicy('short');
    expect(policy).toContain('LENGTH POLICY (MANDATORY)');
    expect(policy).toContain('800–1400 words');
    expect(policy).toContain('1100 words');
  });

  it('returns correct policy for default preset', () => {
    const policy = storyModule.buildLengthPolicy('default');
    expect(policy).toContain('LENGTH POLICY (MANDATORY)');
    expect(policy).toContain('1400–2400 words');
    expect(policy).toContain('1900 words');
  });

  it('returns correct policy for long preset', () => {
    const policy = storyModule.buildLengthPolicy('long');
    expect(policy).toContain('LENGTH POLICY (MANDATORY)');
    expect(policy).toContain('2500–4000 words');
    expect(policy).toContain('3200 words');
  });

  it('returns correct policy for wordTarget override', () => {
    const policy = storyModule.buildLengthPolicy('default', 1000);
    expect(policy).toContain('LENGTH POLICY (MANDATORY)');
    expect(policy).toContain('exactly 1000 words');
    expect(policy).toContain('±100 words');
  });

  it('defaults to default preset for unknown length', () => {
    const policy = storyModule.buildLengthPolicy('unknown');
    expect(policy).toContain('1400–2400 words');
  });

  it('includes structure guidance in preset policies', () => {
    const policy = storyModule.buildLengthPolicy('default');
    expect(policy).toContain('Opening hook');
    expect(policy).toContain('Climax');
    expect(policy).toContain('Closing hook');
  });

  it('does not include structure guidance when wordTarget is set', () => {
    const policy = storyModule.buildLengthPolicy('default', 1500);
    expect(policy).not.toContain('Opening hook');
  });
});

// ── story.js — CHAPTER_LENGTH_PRESETS ───────────────────────────────────────

describe('story.js — CHAPTER_LENGTH_PRESETS', () => {
  it('short preset has correct word counts', () => {
    expect(storyModule.CHAPTER_LENGTH_PRESETS.short).toEqual({
      minWords: 800,
      targetWords: 1100,
      maxWords: 1400,
    });
  });

  it('default preset has correct word counts', () => {
    expect(storyModule.CHAPTER_LENGTH_PRESETS.default).toEqual({
      minWords: 1400,
      targetWords: 1900,
      maxWords: 2400,
    });
  });

  it('long preset has correct word counts', () => {
    expect(storyModule.CHAPTER_LENGTH_PRESETS.long).toEqual({
      minWords: 2500,
      targetWords: 3200,
      maxWords: 4000,
    });
  });
});

// ── story.js — chapterTokenBudget() ────────────────────────────────────────

describe('story.js — chapterTokenBudget()', () => {
  it('sizes the budget from the preset maxWords', () => {
    expect(storyModule.chapterTokenBudget('default')).toBe(2400 * 1.6);
    expect(storyModule.chapterTokenBudget('long')).toBe(4000 * 1.6);
    expect(storyModule.chapterTokenBudget('short')).toBe(1400 * 1.6);
  });

  it('wordTarget overrides the preset', () => {
    expect(storyModule.chapterTokenBudget('short', 2000)).toBe(2000 * 1.6);
  });

  it('clamps to the maximum budget', () => {
    expect(storyModule.chapterTokenBudget('default', 100000)).toBeLessThanOrEqual(8192);
  });

  it('clamps to a sensible minimum', () => {
    expect(storyModule.chapterTokenBudget('default', 10)).toBeGreaterThanOrEqual(1024);
  });
});

// ── story.js — generateChapter length options ───────────────────────────────

describe('story.js — generateChapter length options', () => {
  function writeStory(id, data = {}) {
    fs.mkdirSync(STORIES_DIR, { recursive: true });
    const defaults = {
      id,
      title: 'Test Story',
      genre: 'fantasy',
      tone: 'epic',
      outline: 'A hero journeys forth.',
      createdAt: new Date().toISOString(),
      chapters: [],
    };
    fs.writeFileSync(
      path.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({ ...defaults, ...data }, null, 2),
      'utf8',
    );
  }

  beforeEach(() => {
    storyRag.listDocs.mockReturnValue([]);
    storyRag.addDoc.mockImplementation(() => {});
    storyRag.removeDoc.mockReturnValue(true);
  });

  it('defaults to default length when length option not specified', async () => {
    writeStory('test-length-default-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-default-1234', 1, {});

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('LENGTH POLICY (MANDATORY)');
    expect(prompt).toContain('1400–2400 words');
  });

  it('uses short length when specified', async () => {
    writeStory('test-length-short-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-short-1234', 1, { length: 'short' });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('800–1400 words');
  });

  it('uses long length when specified', async () => {
    writeStory('test-length-long-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-long-1234', 1, { length: 'long' });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('2500–4000 words');
  });

  it('passes a token budget sized to the requested length to ai.ask', async () => {
    writeStory('test-length-budget-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-budget-1234', 1, { length: 'long' });

    const askOptions = ai.ask.mock.calls[0][1];
    expect(askOptions.maxTokens).toBe(storyModule.chapterTokenBudget('long'));
  });

  it('uses wordTarget when specified', async () => {
    writeStory('test-length-target-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-target-1234', 1, { wordTarget: 1500 });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('exactly 1500 words');
    expect(prompt).toContain('±150 words');
  });

  it('wordTarget overrides length preset', async () => {
    writeStory('test-length-override-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:narrator] Test.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-length-override-1234', 1, {
      length: 'short',
      wordTarget: 2000,
    });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('exactly 2000 words');
    expect(prompt).not.toContain('800–1400 words');
  });
});

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

  it('passes aiOptions to both the chapter and summary ai.ask calls', async () => {
    writeStory('test-opts-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter content.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('test-opts-1234', 1, { model: 'mistral' });

    expect(ai.ask).toHaveBeenCalledTimes(2);
    expect(ai.ask).toHaveBeenNthCalledWith(1, expect.any(String), { model: 'mistral' });
    expect(ai.ask).toHaveBeenNthCalledWith(2, expect.any(String), { model: 'mistral' });
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

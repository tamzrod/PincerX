'use strict';

// Mock ai.js so no real HTTP calls are made
jest.mock('../openclaw/ai');
// Mock story-rag.js so tests do not touch the filesystem for RAG docs
jest.mock('../story/story-rag');

const path = require('path');
const fs = require('fs');
const ai = require('../openclaw/ai');
const storyRag = require('../story/story-rag');
const storyModule = require('../story/story');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

/**
 * Remove all files and subdirectories inside STORIES_DIR without deleting the
 * directory itself.  Handles the per-story RAG subdirectories created by
 * story-rag.js (data/stories/<storyId>/).
 */
function cleanupStoriesDir() {
  if (!fs.existsSync(STORIES_DIR)) return;
  for (const entry of fs.readdirSync(STORIES_DIR, { withFileTypes: true })) {
    const full = path.join(STORIES_DIR, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(full, { recursive: true, force: true });
    } else {
      fs.unlinkSync(full);
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
});

// ── story.js — generateChapter() ────────────────────────────────────────────

describe('story.js — generateChapter()', () => {
  /**
   * Helper: write a minimal story JSON file so generateChapter can load it.
   */
  function writeStory(id, data = {}) {
    const fs2 = require('fs');
    const p = require('path');
    fs2.mkdirSync(STORIES_DIR, { recursive: true });
    const defaults = {
      id,
      title: 'Test Story',
      genre: 'fantasy',
      tone: 'epic',
      outline: 'A hero sets out on a quest.',
      createdAt: new Date().toISOString(),
      chapters: [],
    };
    fs2.writeFileSync(
      p.join(STORIES_DIR, `${id}.json`),
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
      fs.readFileSync(require('path').join(STORIES_DIR, 'test-save-1234.json'), 'utf8'),
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
    const fs2 = require('fs');
    const p = require('path');
    fs2.mkdirSync(STORIES_DIR, { recursive: true });
    fs2.writeFileSync(
      p.join(STORIES_DIR, `${id}.json`),
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
    const fs2 = require('fs');
    const p = require('path');
    fs2.mkdirSync(STORIES_DIR, { recursive: true });
    const id = 'del-story-1234';
    fs2.writeFileSync(
      p.join(STORIES_DIR, `${id}.json`),
      JSON.stringify({ id, title: 'T', genre: 'g', tone: 't', outline: 'o', createdAt: new Date().toISOString() }),
      'utf8',
    );

    storyModule.deleteStory(id);

    expect(fs2.existsSync(p.join(STORIES_DIR, `${id}.json`))).toBe(false);
    expect(storyRag.clearStory).toHaveBeenCalledWith(id);
  });

  it('throws when the story does not exist', () => {
    expect(() => storyModule.deleteStory('ghost-story')).toThrow('Story not found');
  });
});

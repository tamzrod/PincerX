'use strict';

const path = require('path');
const fs = require('fs');
const storyRag = require('../story/story-rag');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');
const TEST_STORY_ID = 'test-story-rag-1234';

/**
 * Remove the per-story RAG directory created during tests.
 */
function cleanupTestStory() {
  const dir = path.join(STORIES_DIR, TEST_STORY_ID);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeEach(() => {
  cleanupTestStory();
});

afterEach(() => {
  cleanupTestStory();
});

// ── addDoc / loadDocs ────────────────────────────────────────────────────────

describe('storyRag.addDoc()', () => {
  it('creates the RAG docs file and adds a document', () => {
    const doc = { id: 'char-elena', type: 'character', name: 'Elena', content: 'Protagonist' };
    storyRag.addDoc(TEST_STORY_ID, doc);

    const docsPath = path.join(STORIES_DIR, TEST_STORY_ID, 'rag-docs.json');
    expect(fs.existsSync(docsPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(docsPath, 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe('char-elena');
  });

  it('replaces an existing document with the same id', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'Old' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'Updated' });

    const docs = storyRag.listDocs(TEST_STORY_ID);
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('Updated');
  });

  it('appends multiple documents with distinct ids', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-thomas', type: 'character', name: 'Thomas', content: 'B' });

    const docs = storyRag.listDocs(TEST_STORY_ID);
    expect(docs).toHaveLength(2);
  });
});

// ── removeDoc ────────────────────────────────────────────────────────────────

describe('storyRag.removeDoc()', () => {
  it('removes an existing document and returns true', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-thomas', type: 'character', name: 'Thomas', content: 'B' });

    const removed = storyRag.removeDoc(TEST_STORY_ID, 'char-elena');
    expect(removed).toBe(true);

    const docs = storyRag.listDocs(TEST_STORY_ID);
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('char-thomas');
  });

  it('returns false when the document does not exist', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });
    expect(storyRag.removeDoc(TEST_STORY_ID, 'char-nonexistent')).toBe(false);
  });

  it('returns false gracefully when the story has no RAG docs', () => {
    expect(storyRag.removeDoc(TEST_STORY_ID, 'char-elena')).toBe(false);
  });
});

// ── listDocs ─────────────────────────────────────────────────────────────────

describe('storyRag.listDocs()', () => {
  beforeEach(() => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'lore-city', type: 'lore', title: 'The City', content: 'B' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'summary-1', type: 'summary', chapterNumber: 1, content: 'C' });
  });

  it('returns all documents when no type is specified', () => {
    const docs = storyRag.listDocs(TEST_STORY_ID);
    expect(docs).toHaveLength(3);
  });

  it('filters documents by type "character"', () => {
    const docs = storyRag.listDocs(TEST_STORY_ID, 'character');
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('char-elena');
  });

  it('filters documents by type "lore"', () => {
    const docs = storyRag.listDocs(TEST_STORY_ID, 'lore');
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe('lore-city');
  });

  it('filters documents by type "summary"', () => {
    const docs = storyRag.listDocs(TEST_STORY_ID, 'summary');
    expect(docs).toHaveLength(1);
    expect(docs[0].chapterNumber).toBe(1);
  });

  it('returns an empty array when no documents match the type', () => {
    expect(storyRag.listDocs(TEST_STORY_ID, 'unknown')).toEqual([]);
  });

  it('returns an empty array when the story has no RAG docs', () => {
    expect(storyRag.listDocs('nonexistent-story-999')).toEqual([]);
  });

  it('throws for an invalid story ID', () => {
    expect(() => storyRag.listDocs('../evil')).toThrow(/invalid story id/i);
  });
});

// ── retrieve ─────────────────────────────────────────────────────────────────

/**
 * Helper: add the three standard test documents used by all retrieve tests.
 * Called at the start of each test rather than in a beforeEach to avoid the
 * outer-scope cleanup (which runs before the inner beforeEach) producing a
 * clean slate that then gets re-populated at a timing the first test may miss.
 */
function addRetrieveDocs() {
  storyRag.addDoc(TEST_STORY_ID, {
    id: 'char-elena',
    type: 'character',
    name: 'Elena',
    content: 'Elena is a detective from New Chicago. She is curious and determined.',
  });
  storyRag.addDoc(TEST_STORY_ID, {
    id: 'lore-city',
    type: 'lore',
    title: 'New Chicago',
    content: 'A sprawling city built on the ruins of Old Chicago.',
  });
  storyRag.addDoc(TEST_STORY_ID, {
    id: 'summary-1',
    type: 'summary',
    chapterNumber: 1,
    content: 'Elena arrives in New Chicago and meets her partner Thomas.',
  });
}

describe('storyRag.retrieve()', () => {
  it('returns documents ranked by keyword relevance', () => {
    addRetrieveDocs();
    const results = storyRag.retrieve(TEST_STORY_ID, 'Elena detective curious');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe('char-elena');
  });

  it('matches on the title field of lore documents', () => {
    addRetrieveDocs();
    const results = storyRag.retrieve(TEST_STORY_ID, 'New Chicago city');
    expect(results.some((d) => d.id === 'lore-city')).toBe(true);
  });

  it('matches on the name field of character documents', () => {
    addRetrieveDocs();
    const results = storyRag.retrieve(TEST_STORY_ID, 'Elena');
    expect(results.some((d) => d.id === 'char-elena')).toBe(true);
  });

  it('returns an empty array when no keywords match', () => {
    addRetrieveDocs();
    expect(storyRag.retrieve(TEST_STORY_ID, 'zzxxx completely unrelated')).toEqual([]);
  });

  it('limits results to topK', () => {
    addRetrieveDocs();
    const results = storyRag.retrieve(TEST_STORY_ID, 'Chicago Elena city', 1);
    expect(results).toHaveLength(1);
  });

  it('filters out short stop words (<= 2 chars)', () => {
    addRetrieveDocs();
    const results = storyRag.retrieve(TEST_STORY_ID, 'is it');
    expect(results).toEqual([]);
  });

  it('returns an empty array when the story has no RAG docs', () => {
    expect(storyRag.retrieve('nonexistent-story-999', 'detective')).toEqual([]);
  });
});

// ── clearStory ───────────────────────────────────────────────────────────────

describe('storyRag.clearStory()', () => {
  it('removes the rag-docs.json file and its directory', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });

    const docsPath = path.join(STORIES_DIR, TEST_STORY_ID, 'rag-docs.json');
    const dir = path.join(STORIES_DIR, TEST_STORY_ID);
    expect(fs.existsSync(docsPath)).toBe(true);

    storyRag.clearStory(TEST_STORY_ID);

    expect(fs.existsSync(docsPath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('is a no-op when the story has no RAG directory', () => {
    expect(() => storyRag.clearStory('nonexistent-story-999')).not.toThrow();
  });

  it('throws for an invalid story ID', () => {
    expect(() => storyRag.clearStory('../evil')).toThrow(/invalid story id/i);
    expect(() => storyRag.clearStory('../../etc/passwd')).toThrow(/invalid story id/i);
  });

  it('returns empty listDocs after clear', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-elena', type: 'character', name: 'Elena', content: 'A' });
    storyRag.clearStory(TEST_STORY_ID);
    expect(storyRag.listDocs(TEST_STORY_ID)).toEqual([]);
  });
});

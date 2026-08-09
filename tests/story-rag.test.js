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

// ── New knowledge type tests ─────────────────────────────────────────────────

describe('storyRag VALID_TYPES', () => {
  it('exports VALID_TYPES array with all expected types', () => {
    expect(storyRag.VALID_TYPES).toContain('character');
    expect(storyRag.VALID_TYPES).toContain('place');
    expect(storyRag.VALID_TYPES).toContain('lore');
    expect(storyRag.VALID_TYPES).toContain('world');
    expect(storyRag.VALID_TYPES).toContain('system');
    expect(storyRag.VALID_TYPES).toContain('parameter');
    expect(storyRag.VALID_TYPES).toContain('arc_boundary');
    expect(storyRag.VALID_TYPES).toContain('summary');
  });

  it('isValidType returns true for valid types', () => {
    expect(storyRag.isValidType('character')).toBe(true);
    expect(storyRag.isValidType('place')).toBe(true);
    expect(storyRag.isValidType('system')).toBe(true);
    expect(storyRag.isValidType('parameter')).toBe(true);
    expect(storyRag.isValidType('arc_boundary')).toBe(true);
  });

  it('isValidType returns false for invalid types', () => {
    expect(storyRag.isValidType('characterx')).toBe(false);
    expect(storyRag.isValidType('place123')).toBe(false);
    expect(storyRag.isValidType('')).toBe(false);
    expect(storyRag.isValidType('invalid')).toBe(false);
  });
});

describe('storyRag upsertKnowledge()', () => {
  it('adds a new document when id does not exist', () => {
    const doc = { id: 'place-forest', type: 'place', title: 'The Forest', content: 'A dark forest' };
    const added = storyRag.upsertKnowledge(TEST_STORY_ID, doc);

    expect(added).toBe(true);
    const docs = storyRag.listDocs(TEST_STORY_ID);
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('The Forest');
  });

  it('updates an existing document when id exists', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'system-magic', type: 'system', title: 'Magic', content: 'Old description' });
    const updated = storyRag.upsertKnowledge(TEST_STORY_ID, { id: 'system-magic', type: 'system', title: 'Magic', content: 'New description' });

    expect(updated).toBe(false);
    const docs = storyRag.listDocs(TEST_STORY_ID, 'system');
    expect(docs).toHaveLength(1);
    expect(docs[0].content).toBe('New description');
  });

  it('adds createdAt timestamp when adding new document', () => {
    const doc = { id: 'param-ban', type: 'parameter', title: 'Time Ban', content: 'No time travel' };
    storyRag.upsertKnowledge(TEST_STORY_ID, doc);

    const docs = storyRag.listDocs(TEST_STORY_ID, 'parameter');
    expect(docs[0].createdAt).toBeDefined();
  });
});

describe('storyRag batchUpsert()', () => {
  it('adds multiple new documents', () => {
    const docs = [
      { id: 'place-1', type: 'place', title: 'Place A', content: 'A place' },
      { id: 'place-2', type: 'place', title: 'Place B', content: 'Another place' },
      { id: 'system-1', type: 'system', title: 'Magic', content: 'Magic system' },
    ];
    storyRag.batchUpsert(TEST_STORY_ID, docs);

    const allDocs = storyRag.listDocs(TEST_STORY_ID);
    expect(allDocs).toHaveLength(3);
  });

  it('updates existing documents by id', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'place-1', type: 'place', title: 'Old Title', content: 'Old content' });
    storyRag.batchUpsert(TEST_STORY_ID, [{ id: 'place-1', type: 'place', title: 'New Title', content: 'New content' }]);

    const docs = storyRag.listDocs(TEST_STORY_ID, 'place');
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe('New Title');
  });
});

describe('storyRag listDocsByType()', () => {
  beforeEach(() => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-1', type: 'character', name: 'Elena', content: 'A' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'place-1', type: 'place', title: 'Forest', content: 'B' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'lore-1', type: 'lore', title: 'World', content: 'C' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'system-1', type: 'system', title: 'Magic', content: 'D' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'param-1', type: 'parameter', title: 'Rule', content: 'E' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'arc-1', type: 'arc_boundary', title: 'Arc 1', content: 'F' });
  });

  it('returns all documents grouped by type', () => {
    const grouped = storyRag.listDocsByType(TEST_STORY_ID);

    expect(grouped.character).toHaveLength(1);
    expect(grouped.place).toHaveLength(1);
    expect(grouped.lore).toHaveLength(1);
    expect(grouped.system).toHaveLength(1);
    expect(grouped.parameter).toHaveLength(1);
    expect(grouped.arc_boundary).toHaveLength(1);
    expect(grouped.summary).toHaveLength(0);
    expect(grouped.world).toHaveLength(0);
  });
});

describe('storyRag getDoc()', () => {
  it('returns a document by id', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-1', type: 'character', name: 'Elena', content: 'A' });
    const doc = storyRag.getDoc(TEST_STORY_ID, 'char-1');

    expect(doc).not.toBeNull();
    expect(doc.name).toBe('Elena');
  });

  it('returns null for non-existent document', () => {
    const doc = storyRag.getDoc(TEST_STORY_ID, 'nonexistent');
    expect(doc).toBeNull();
  });
});

describe('storyRag formatKnowledgeForPrompt()', () => {
  beforeEach(() => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'char-1', type: 'character', name: 'Elena', role: 'hero', personality: 'brave', content: 'Protagonist' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'param-1', type: 'parameter', title: 'Time Rule', content: 'No time travel', context: 'Always', boundary: 'Never' });
    storyRag.addDoc(TEST_STORY_ID, { id: 'place-1', type: 'place', title: 'Forest', content: 'Dark forest' });
  });

  it('returns a formatted string with knowledge sections', () => {
    const result = storyRag.formatKnowledgeForPrompt(TEST_STORY_ID);

    expect(result).toContain('## STORY PARAMETERS');
    expect(result).toContain('Time Rule');
    expect(result).toContain('## CHARACTERS');
    expect(result).toContain('Elena');
    expect(result).toContain('## PLACES');
    expect(result).toContain('Forest');
  });

  it('respects include options', () => {
    const result = storyRag.formatKnowledgeForPrompt(TEST_STORY_ID, {
      includeCharacters: false,
      includeParameters: true,
      includePlaces: false,
    });

    expect(result).toContain('## STORY PARAMETERS');
    expect(result).toContain('Time Rule');
    expect(result).not.toContain('## CHARACTERS');
    expect(result).not.toContain('Elena');
    expect(result).not.toContain('## PLACES');
  });

  it('returns empty string when no knowledge exists', () => {
    const result = storyRag.formatKnowledgeForPrompt('empty-story-999');
    expect(result).toBe('');
  });
});

// ── reader_experience type + state helpers ─────────────────────────────────

describe('storyRag reader_experience', () => {
  it('accepts reader_experience as a valid type', () => {
    expect(storyRag.isValidType('reader_experience')).toBe(true);
    expect(storyRag.VALID_TYPES).toContain('reader_experience');
  });

  it('stores and retrieves a reader_experience doc via addDoc/getDoc', () => {
    storyRag.addDoc(TEST_STORY_ID, {
      id: 'reader-experience',
      type: 'reader_experience',
      config: { primary: 'Curiosity', secondary: 'Tension', intensity: 'High', pacing: 'Moderate' },
    });
    const doc = storyRag.getDoc(TEST_STORY_ID, 'reader-experience');
    expect(doc).not.toBeNull();
    expect(doc.type).toBe('reader_experience');
    expect(doc.config.primary).toBe('Curiosity');
  });

  it('getExperienceConfig returns null when no config is set', () => {
    expect(storyRag.getExperienceConfig(TEST_STORY_ID)).toBeNull();
  });

  it('setExperienceConfig stores config and getExperienceConfig returns it', () => {
    const config = { primary: 'Mystery', secondary: 'Wonder', intensity: 'Low', pacing: 'Slow' };
    storyRag.setExperienceConfig(TEST_STORY_ID, config);
    const got = storyRag.getExperienceConfig(TEST_STORY_ID);
    expect(got).toEqual(config);
  });

  it('setExperienceConfig preserves previously evolved state', () => {
    storyRag.setExperienceConfig(TEST_STORY_ID, { primary: 'Curiosity', secondary: 'Tension', intensity: 'High', pacing: 'Moderate' });
    storyRag.saveExperienceState(TEST_STORY_ID, {
      currentState: { curiosity: 72, tension: 48 },
      readerQuestions: ['Who is Cedric?'],
      trajectory: [{ chapterNumber: 1, movement: 'calm → curiosity', passed: true }],
      lastChapterNumber: 1,
    });
    // Replacing the config must not wipe the evolved state.
    storyRag.setExperienceConfig(TEST_STORY_ID, { primary: 'Suspense', secondary: 'Tension', intensity: 'High', pacing: 'Fast' });
    const state = storyRag.getExperienceState(TEST_STORY_ID);
    expect(state.config.primary).toBe('Suspense');
    expect(state.currentState.curiosity).toBe(72);
    expect(state.readerQuestions).toEqual(['Who is Cedric?']);
    expect(state.trajectory).toHaveLength(1);
  });

  it('saveExperienceState merges into the existing doc and stamps metadata', () => {
    storyRag.setExperienceConfig(TEST_STORY_ID, { primary: 'Curiosity', secondary: 'Tension', intensity: 'High', pacing: 'Moderate' });
    storyRag.saveExperienceState(TEST_STORY_ID, { currentState: { curiosity: 80 }, lastChapterNumber: 2 });
    const state = storyRag.getExperienceState(TEST_STORY_ID);
    expect(state.id).toBe('reader-experience');
    expect(state.type).toBe('reader_experience');
    expect(state.currentState.curiosity).toBe(80);
    expect(state.lastChapterNumber).toBe(2);
    expect(state.config.primary).toBe('Curiosity');
    expect(state.updatedAt).toBeTruthy();
  });

  it('getExperienceState returns null when no doc exists', () => {
    expect(storyRag.getExperienceState('empty-story-rex-999')).toBeNull();
  });

  it('includes reader_experience in listDocsByType grouping', () => {
    storyRag.addDoc(TEST_STORY_ID, { id: 'reader-experience', type: 'reader_experience', config: { primary: 'Curiosity' } });
    const grouped = storyRag.listDocsByType(TEST_STORY_ID);
    expect(grouped.reader_experience).toHaveLength(1);
    expect(grouped.reader_experience[0].config.primary).toBe('Curiosity');
  });
});


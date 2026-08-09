// Integration test for the full story-generation pipeline.
// Exercises the REAL story.create + story.generateChapter code paths,
// stubbing only ai.ask (the LLM transport) with realistic LLM-shaped output.
// Verifies persistence, RAG seeding, chapter storage, and coherence plumbing.

jest.mock('../lib/ai');

const fs = require('fs');
const path = require('path');
const os = require('os');

const ai = require('../lib/ai');
const story = require('../story/story');
const storyRag = require('../story/story-rag');

// Point STORIES_DIR at a temp dir so we never touch real data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pincerx-story-it-'));

// story.js reads STORIES_DIR at module load from a const, so override the
// data dir by creating a symlink-free isolated copy: we set the env before
// require by re-requiring with a patched path. Instead, simplest: copy the
// approach used by story.test.js — it relies on the real data/stories dir,
// so we mirror that but clean up our stories afterwards.
const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');
fs.mkdirSync(STORIES_DIR, { recursive: true });

const CREATED_IDS = [];
afterAll(() => {
  for (const id of CREATED_IDS) {
    const f = path.join(STORIES_DIR, `${id}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('story generation pipeline (integration)', () => {
  it('creates a story from an LLM outline and seeds characters + lore into RAG', async () => {
    ai.ask.mockResolvedValueOnce(JSON.stringify({
      outline: 'Act 1: A storm strands travelers at an inn. Act 2: A hidden passage is discovered. Act 3: The truth of the innkeeper is revealed.',
      characters: [
        { name: 'Maren', role: 'protagonist', gender: 'female', personality: 'curious, brave', backstory: 'A cartographer searching for her missing brother.' },
        { name: 'Old Bram', role: 'supporting', gender: 'male', personality: 'cryptic, kind', backstory: 'The innkeeper with a buried secret.' },
      ],
      locations: [
        { title: 'The Wayward Inn', description: 'A lone inn on the moor, lamp always lit.' },
        { title: 'The Moor', description: 'A fog-drenched expanse surrounding the inn.' },
      ],
    }));

    const result = await story.create('The Wayward Inn', 'mystery', 'eerie');
    CREATED_IDS.push(result.id);

    expect(result.id).toMatch(/^\d+-the-wayward-inn$/);
    expect(result.title).toBe('The Wayward Inn');
    expect(result.genre).toBe('mystery');
    expect(result.tone).toBe('eerie');
    expect(result.outline).toContain('Act 1');
    expect(result.createdAt).toBeTruthy();

    // Persisted to disk.
    const onDisk = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, `${result.id}.json`), 'utf8'));
    expect(onDisk.id).toBe(result.id);
    expect(onDisk.outline).toBe(result.outline);

    // RAG seeded with characters.
    const chars = storyRag.listDocs(result.id, 'character');
    expect(chars.length).toBe(2);
    const names = chars.map((c) => c.name).sort();
    expect(names).toEqual(['Maren', 'Old Bram']);
    expect(chars.find((c) => c.name === 'Maren').voiceId).toBeTruthy();

    // RAG seeded with lore.
    const lore = storyRag.listDocs(result.id, 'lore');
    expect(lore.length).toBe(2);
    expect(lore.some((l) => l.title === 'The Wayward Inn')).toBe(true);
  });

  it('generates a chapter, persists it, stores a summary, and returns coherence', async () => {
    // Create a story first.
    ai.ask.mockResolvedValueOnce(JSON.stringify({
      outline: 'Act 1: Setup. Act 2: Conflict. Act 3: Resolution.',
      characters: [
        { name: 'Elena', role: 'protagonist', gender: 'female', personality: 'determined', backstory: 'A detective.' },
      ],
      locations: [{ title: 'The Precinct', description: 'A bustling police precinct.' }],
    }));
    const created = await story.create('Cold Case', 'thriller', 'tense');
    CREATED_IDS.push(created.id);

    // Chapter content the "LLM" returns: well-formed tagged paragraphs.
    const chapterJson = JSON.stringify({
      content: [
        '[speaker:narrator][emotion:neutral] The rain hammered the precinct windows as Elena stared at the cold case file.',
        '[speaker:Elena][emotion:curious] "There has to be a pattern here."',
        '[speaker:narrator][emotion:neutral] She spread the photographs across her desk, each one a frozen moment of a forgotten crime.',
        '[speaker:Elena][emotion:happy] "I finally see it."',
      ].join('\n\n'),
    });
    // generateChapter calls ai.ask for the chapter, then again for the summary,
    // again for new-character extraction, again for knowledge extraction, and
    // coherence.checkChapter calls it once more. Queue enough responses.
    ai.ask
      .mockResolvedValueOnce(chapterJson)   // chapter content
      .mockResolvedValueOnce('Summary: Elena finds a pattern in cold case photos.') // summary
      .mockResolvedValueOnce(JSON.stringify([])) // new characters (none)
      .mockResolvedValueOnce(JSON.stringify({ elements: [] })) // knowledge
      .mockResolvedValueOnce(JSON.stringify({ violations: [], score: 100 })); // coherence

    const result = await story.generateChapter(created.id, 1, { dialogRatio: 50 });

    expect(result.storyId).toBe(created.id);
    expect(result.chapterNumber).toBe(1);
    expect(result.content).toContain('[speaker:Elena]');
    expect(result.content).toContain('pattern');
    expect(result.coherence).not.toBeNull();

    // Chapter persisted to the story file.
    const onDisk = JSON.parse(fs.readFileSync(path.join(STORIES_DIR, `${created.id}.json`), 'utf8'));
    expect(onDisk.chapters.length).toBe(1);
    expect(onDisk.chapters[0].number).toBe(1);
    expect(onDisk.chapters[0].content).toBe(result.content);

    // Summary stored in RAG for continuity.
    const summaries = storyRag.listDocs(created.id, 'summary');
    expect(summaries.length).toBe(1);
    expect(summaries[0].chapterNumber).toBe(1);
  });

  it('rejects chapter generation for a non-existent story', async () => {
    await expect(story.generateChapter('999999-does-not-exist', 1)).rejects.toThrow('Story not found');
  });
});

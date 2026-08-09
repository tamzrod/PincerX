'use strict';

// Integration test for the Name & Place Localization feature.
// Exercises the REAL story.generateChapter + story.coherence code paths,
// mocking only ai.ask (the LLM transport) and story-rag (storage) so no real
// LLM/HTTP/filesystem is touched. Verifies the acceptance-test scenarios:
//  - generation prompt includes the canonical-names block
//  - regeneration preserves canonical names
//  - coherence recognises source-name aliases as the SAME entity
//  - existing stories continue working without localization

jest.mock('../lib/ai');
jest.mock('../story/story-rag');

const path = require('path');
const fs = require('fs');
const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const storyModule = require('../story/story');
const coherence = require('../story/story-coherence');
const localization = require('../story/story-localization');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

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
    title: 'Longhe Saga',
    genre: 'drama',
    tone: 'tense',
    outline: 'A family dynasty crumbles.',
    createdAt: new Date().toISOString(),
    chapters: [],
  };
  fs.writeFileSync(
    path.join(STORIES_DIR, `${id}.json`),
    JSON.stringify({ ...defaults, ...data }, null, 2),
    'utf8',
  );
}

afterEach(() => {
  jest.clearAllMocks();
  cleanupStoriesDir();
});

// A canonical entity map for the acceptance-test story (Wei Chen → Cedric Vale,
// Lin Yue → Isabella Hart, Zhao Family → Eldridge Family, Longhe Group →
// Meridian Holdings, Jiangnan → Westmere).
const ENTITY_MAP_DOC = {
  id: 'entity-map',
  type: 'entity_map',
  config: { style: 'english_distinctive' },
  entities: [
    { id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', displayName: 'Cedric Vale' },
    { id: 'ent-lin-yue', entityType: 'character', sourceNames: ['Lin Yue'], canonicalName: 'Isabella Hart', displayName: 'Isabella Hart' },
    { id: 'ent-zhao-family', entityType: 'clan', sourceNames: ['Zhao Family'], canonicalName: 'Eldridge Family', displayName: 'Eldridge Family' },
    { id: 'ent-longhe-group', entityType: 'company', sourceNames: ['Longhe Group'], canonicalName: 'Meridian Holdings', displayName: 'Meridian Holdings' },
    { id: 'ent-jiangnan', entityType: 'place', sourceNames: ['Jiangnan'], canonicalName: 'Westmere', displayName: 'Westmere' },
  ],
};

function setupRagWithLocalization() {
  storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
  storyRag.getEntityMapDoc.mockReturnValue(ENTITY_MAP_DOC);
  storyRag.getEntityMap.mockReturnValue(ENTITY_MAP_DOC.entities);
  storyRag.listDocs.mockImplementation((storyId, type) => {
    if (type === 'character') {
      return [
        { id: 'char-wei', type: 'character', name: 'Wei Chen', role: 'protagonist', gender: 'male', personality: 'driven', backstory: 'Heir to a crumbling empire.', speechStyle: 'measured', content: 'Name: Wei Chen.' },
        { id: 'char-lin', type: 'character', name: 'Lin Yue', role: 'deuteragonist', gender: 'female', personality: 'sharp', backstory: 'Strategist.', speechStyle: 'direct', content: 'Name: Lin Yue.' },
      ];
    }
    if (type === 'lore') {
      return [{ id: 'lore-longhe', type: 'lore', title: 'Longhe Group', content: 'A conglomerate.' }];
    }
    return [];
  });
  storyRag.addDoc.mockImplementation(() => {});
  storyRag.saveEntityMapDoc.mockImplementation(() => {});
  storyRag._slugify.mockImplementation((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
}

// ── 8. Generation prompt includes canonical names ──────────────────────────

describe('generateChapter injects canonical names into the prompt', () => {
  beforeEach(setupRagWithLocalization);

  it('includes the CANONICAL NAMES block with every mapping', async () => {
    writeStory('loc-gen-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Cedric Vale][emotion:resolve]Cedric Vale surveyed Westmere.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('loc-gen-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/CANONICAL NAMES/);
    expect(prompt).toMatch(/Wei Chen/);
    expect(prompt).toMatch(/→ Cedric Vale/);
    expect(prompt).toMatch(/Lin Yue/);
    expect(prompt).toMatch(/→ Isabella Hart/);
    expect(prompt).toMatch(/Zhao Family/);
    expect(prompt).toMatch(/→ Eldridge Family/);
    expect(prompt).toMatch(/Longhe Group/);
    expect(prompt).toMatch(/→ Meridian Holdings/);
    expect(prompt).toMatch(/Jiangnan/);
    expect(prompt).toMatch(/→ Westmere/);
  });

  it('does NOT inject a canonical-names block when localization is inactive', async () => {
    writeStory('loc-gen-off-1234');
    // No localization configured → legacy behaviour.
    storyRag.getLocalizationConfig.mockReturnValue(null);
    storyRag.getEntityMapDoc.mockReturnValue(null);
    storyRag.getEntityMap.mockReturnValue([]);
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'Chapter text.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('loc-gen-off-1234', 1);

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).not.toMatch(/CANONICAL NAMES/);
  });
});

// ── 9. Regeneration preserves canonical names ──────────────────────────────

describe('regeneration preserves canonical names', () => {
  beforeEach(setupRagWithLocalization);

  it('includes the canonical-names block in a REGENERATION prompt', async () => {
    writeStory('loc-regen-1234', {
      chapters: [{ number: 1, content: 'Original chapter.', status: 'complete' }],
    });
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: '[speaker:Cedric Vale][emotion:resolve]Cedric Vale stood firm.' }))
      .mockResolvedValueOnce('Summary.');

    await storyModule.generateChapter('loc-regen-1234', 1, {
      regenerate: { evidence: 'name drift detected', recommendation: 'keep canonical names' },
    });

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/Regenerate a chapter/);
    expect(prompt).toMatch(/CANONICAL NAMES/);
    expect(prompt).toMatch(/→ Cedric Vale/);
    expect(prompt).toMatch(/Do NOT revert/);
  });
});

// ── 10. Coherence recognizes aliases as the same entity ────────────────────

describe('coherence recognises source-name aliases + canonical names as one entity', () => {
  beforeEach(setupRagWithLocalization);

  it('treats a canonical speaker name as the same character as its source name', async () => {
    // Chapter uses the canonical name "Cedric Vale" as a speaker tag, while
    // the character profile lists the source name "Wei Chen". Coherence must
    // NOT report them as two different characters — it must recognise the
    // alias and check the SAME entity.
    const chapterContent = '[speaker:Cedric Vale][emotion:resolve]Cedric Vale addressed Isabella Hart at Meridian Holdings in Westmere.';
    ai.ask.mockResolvedValue(JSON.stringify({ issues: [], boundaries: [], confidence: 1.0 }));

    const result = await coherence.checkChapter('loc-coh-1234', chapterContent, {}, {});

    // No "unknown character" / "name mismatch" warnings for the canonical name.
    expect(result.isConsistent).toBe(true);
    expect(result.warnings).toEqual([]);
    // The character check prompt should use the canonical display name.
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toMatch(/Name: Cedric Vale/);
  });

  it('recognises the source name alias too', async () => {
    // Chapter uses the SOURCE name "Wei Chen" as a speaker tag.
    const chapterContent = '[speaker:Wei Chen][emotion:resolve]Wei Chen spoke.';
    ai.ask.mockResolvedValue(JSON.stringify({ issues: [], boundaries: [], confidence: 1.0 }));

    const result = await coherence.checkChapter('loc-coh-src-1234', chapterContent, {}, {});
    expect(result.isConsistent).toBe(true);
  });
});

// ── 11. Existing stories continue working without localization ─────────────

describe('existing stories without localization are unaffected', () => {
  beforeEach(() => {
    storyRag.listDocs.mockReturnValue([]);
    storyRag.addDoc.mockImplementation(() => {});
    storyRag.getLocalizationConfig.mockReturnValue(null);
    storyRag.getEntityMapDoc.mockReturnValue(null);
    storyRag.getEntityMap.mockReturnValue([]);
  });

  it('generates a chapter with no canonical-names block and no errors', async () => {
    writeStory('loc-legacy-1234');
    ai.ask
      .mockResolvedValueOnce(JSON.stringify({ content: 'A normal chapter.' }))
      .mockResolvedValueOnce('Summary.');

    const result = await storyModule.generateChapter('loc-legacy-1234', 1);
    expect(result.content).toBe('A normal chapter.');
    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).not.toMatch(/CANONICAL NAMES/);
  });
});

// ── 21. Final acceptance test (multi-entity, stable identity) ──────────────

describe('acceptance: stable canonical identity across the entity map', () => {
  beforeEach(() => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.getEntityMap.mockReturnValue(ENTITY_MAP_DOC.entities);
    storyRag.getEntityMapDoc.mockReturnValue(ENTITY_MAP_DOC);
  });

  it('every acceptance-test entity has a stable, unique canonical identity', () => {
    const names = ENTITY_MAP_DOC.entities.map((e) => e.canonicalName);
    // All canonical names are unique (no two entities share a name).
    expect(new Set(names).size).toBe(names.length);
    // Source names resolve to their canonical display names.
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Wei Chen')).toBe('Cedric Vale');
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Lin Yue')).toBe('Isabella Hart');
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Zhao Family')).toBe('Eldridge Family');
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Longhe Group')).toBe('Meridian Holdings');
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Jiangnan')).toBe('Westmere');
    // Canonical names resolve to themselves.
    expect(localization.resolveNameWithMap(ENTITY_MAP_DOC, 'Cedric Vale')).toBe('Cedric Vale');
    // The canonical-names block lists all five entities.
    const block = localization.buildCanonicalNamesBlock('acceptance-story');
    for (const n of names) expect(block).toContain(n);
  });
});

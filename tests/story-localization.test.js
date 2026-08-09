'use strict';

// Mock dependencies — no real LLM/HTTP calls. The real story-rag storage is
// exercised in story-rag.test.js + the integration test; here we mock it so we
// can drive the localization logic deterministically.
jest.mock('../lib/ai');
jest.mock('../story/story-rag');

const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const localization = require('../story/story-localization');

afterEach(() => {
  jest.clearAllMocks();
});

// ── 1. Localization configuration ──────────────────────────────────────────

describe('localization.validateConfig', () => {
  it('accepts each machine-id style and normalises', () => {
    for (const style of localization.LOCALIZATION_STYLES) {
      const { valid, normalized } = localization.validateConfig({ style });
      expect(valid).toBe(true);
      expect(normalized).toEqual({ style });
    }
  });

  it('accepts display labels at the boundary and normalises to machine ids', () => {
    const { valid, normalized } = localization.validateConfig({ style: 'English — Distinctive' });
    expect(valid).toBe(true);
    expect(normalized).toEqual({ style: 'english_distinctive' });
  });

  it('rejects an unknown style', () => {
    const { valid, errors } = localization.validateConfig({ style: 'pirate' });
    expect(valid).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-object config', () => {
    const { valid } = localization.validateConfig(null);
    expect(valid).toBe(false);
  });

  it('default config is "original" (preserves existing behaviour)', () => {
    expect(localization.DEFAULT_CONFIG).toEqual({ style: 'original' });
  });
});

describe('localization.isActive', () => {
  it('is false when no config is stored', () => {
    storyRag.getLocalizationConfig.mockReturnValue(null);
    expect(localization.isActive('s1')).toBe(false);
  });

  it('is false when style is "original"', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'original' });
    expect(localization.isActive('s1')).toBe(false);
  });

  it('is true when style is a localizing style', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    expect(localization.isActive('s1')).toBe(true);
  });
});

// ── 2/3/4. Canonical character / place / organization mapping ─────────────

describe('localization.addOrUpdateMapping', () => {
  beforeEach(() => {
    storyRag.getEntityMapDoc.mockReturnValue(null);
    storyRag._slugify.mockImplementation((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  });

  it('creates a character mapping with a stable id', () => {
    const { entity, created } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Cedric Vale',
    });
    expect(created).toBe(true);
    expect(entity.id).toBe('ent-wei-chen');
    expect(entity.entityType).toBe('character');
    expect(entity.sourceNames).toEqual(['Wei Chen']);
    expect(entity.canonicalName).toBe('Cedric Vale');
    expect(entity.displayName).toBe('Cedric Vale');
    expect(entity.userApproved).toBe(false);
    expect(entity.locked).toBe(false);
    expect(storyRag.saveEntityMapDoc).toHaveBeenCalled();
  });

  it('creates a place mapping', () => {
    const { entity, created } = localization.addOrUpdateMapping('s1', {
      entityType: 'place', sourceName: 'Jiangnan', canonicalName: 'Westmere',
    });
    expect(created).toBe(true);
    expect(entity.entityType).toBe('place');
    expect(entity.canonicalName).toBe('Westmere');
  });

  it('creates an organization mapping', () => {
    const { entity, created } = localization.addOrUpdateMapping('s1', {
      entityType: 'organization', sourceName: 'Longhe Group', canonicalName: 'Meridian Holdings',
    });
    expect(created).toBe(true);
    expect(entity.entityType).toBe('organization');
    expect(entity.canonicalName).toBe('Meridian Holdings');
  });

  it('updates an existing mapping for the same source name (no duplicate)', () => {
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{
        id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'],
        canonicalName: 'Cedric Vale', displayName: 'Cedric Vale', userApproved: false, locked: false,
      }],
    });
    const { entity, created } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Julian Mercer',
    });
    expect(created).toBe(false);
    expect(entity.canonicalName).toBe('Julian Mercer');
    expect(entity.displayName).toBe('Julian Mercer');
  });

  it('merges a new source alias into an existing entity when the canonical name matches', () => {
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{
        id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'],
        canonicalName: 'Cedric Vale', displayName: 'Cedric Vale',
      }],
    });
    // Adding "Wei Chen" again with the SAME canonical name updates in place.
    const { created } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Cedric Vale',
    });
    expect(created).toBe(false);
  });
});

// ── 5/6. User override + locked/approved mapping ───────────────────────────

describe('localization user override + locked mappings', () => {
  beforeEach(() => {
    storyRag.getEntityMapDoc.mockReturnValue(null);
    storyRag._slugify.mockImplementation((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  });

  it('marks a user-approved mapping as authoritative + locked', () => {
    const { entity } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Julian Mercer',
      userApproved: true, locked: true,
    });
    expect(entity.userApproved).toBe(true);
    expect(entity.locked).toBe(true);
  });

  it('does NOT silently change a locked canonical name on a non-user update', () => {
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{
        id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'],
        canonicalName: 'Julian Mercer', displayName: 'Julian Mercer', userApproved: true, locked: true,
      }],
    });
    // A non-user (LLM-suggested) update must NOT override the locked name.
    const { entity } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Cedric Vale',
    });
    expect(entity.canonicalName).toBe('Julian Mercer');
  });

  it('allows a user-approved update to change a locked name', () => {
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{
        id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'],
        canonicalName: 'Julian Mercer', displayName: 'Julian Mercer', userApproved: true, locked: true,
      }],
    });
    const { entity } = localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Adrian Cole',
      userApproved: true, locked: true,
    });
    expect(entity.canonicalName).toBe('Adrian Cole');
  });
});

// ── 13. Duplicate canonical names are prevented ────────────────────────────

describe('localization duplicate canonical name prevention', () => {
  beforeEach(() => {
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{
        id: 'ent-wei-chen', entityType: 'character', sourceNames: ['Wei Chen'],
        canonicalName: 'Cedric Vale', displayName: 'Cedric Vale',
      }],
    });
  });

  it('throws when assigning the same canonical name to a DIFFERENT entity', () => {
    expect(() => localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Lin Yue', canonicalName: 'Cedric Vale',
    })).toThrow(/already assigned to another entity/);
  });

  it('allows the same canonical name for the SAME entity (idempotent update)', () => {
    expect(() => localization.addOrUpdateMapping('s1', {
      entityType: 'character', sourceName: 'Wei Chen', canonicalName: 'Cedric Vale',
    })).not.toThrow();
  });
});

// ── 7. Mapping retrieval + alias resolution ────────────────────────────────

describe('localization.resolveName / findEntity', () => {
  const MAP = {
    entities: [
      { id: 'ent-wei-chen', sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', displayName: 'Cedric Vale' },
      { id: 'ent-jiangnan', sourceNames: ['Jiangnan'], canonicalName: 'Westmere', displayName: 'Westmere' },
    ],
  };

  it('resolves a source-name alias to the canonical display name', () => {
    expect(localization.resolveNameWithMap(MAP, 'Wei Chen')).toBe('Cedric Vale');
    expect(localization.resolveNameWithMap(MAP, 'Jiangnan')).toBe('Westmere');
  });

  it('resolves a canonical name to itself (already canonical)', () => {
    expect(localization.resolveNameWithMap(MAP, 'Cedric Vale')).toBe('Cedric Vale');
  });

  it('returns the original name unchanged when no mapping exists', () => {
    expect(localization.resolveNameWithMap(MAP, 'Unknown Person')).toBe('Unknown Person');
  });

  it('is case-insensitive', () => {
    expect(localization.resolveNameWithMap(MAP, 'wei chen')).toBe('Cedric Vale');
  });

  it('findEntity returns the entity for either alias or canonical name', () => {
    expect(localization.findEntity(MAP, 'Wei Chen').id).toBe('ent-wei-chen');
    expect(localization.findEntity(MAP, 'Cedric Vale').id).toBe('ent-wei-chen');
    expect(localization.findEntity(MAP, 'Nobody')).toBeNull();
  });
});

// ── 8. Generation prompt includes canonical names ──────────────────────────

describe('localization.buildCanonicalNamesBlock', () => {
  it('returns "" when localization is inactive', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'original' });
    storyRag.getEntityMap.mockReturnValue([
      { sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale' },
    ]);
    expect(localization.buildCanonicalNamesBlock('s1')).toBe('');
  });

  it('returns "" when active but no mappings exist', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.getEntityMap.mockReturnValue([]);
    expect(localization.buildCanonicalNamesBlock('s1')).toBe('');
  });

  it('lists each source → canonical pair with a "use consistently" instruction', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.getEntityMap.mockReturnValue([
      { sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', displayName: 'Cedric Vale' },
      { sourceNames: ['Jiangnan'], canonicalName: 'Westmere', displayName: 'Westmere' },
    ]);
    const block = localization.buildCanonicalNamesBlock('s1');
    expect(block).toMatch(/CANONICAL NAMES/);
    expect(block).toMatch(/Wei Chen/);
    expect(block).toMatch(/→ Cedric Vale/);
    expect(block).toMatch(/Use "Cedric Vale" in all generated prose/);
    expect(block).toMatch(/Jiangnan/);
    expect(block).toMatch(/→ Westmere/);
    // Must instruct the model not to revert / invent new names.
    expect(block).toMatch(/Do NOT revert/);
  });

  it('does NOT leak internal ids / locked flags to the model', () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english' });
    storyRag.getEntityMap.mockReturnValue([
      { id: 'ent-wei-chen', sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', locked: true, userApproved: true },
    ]);
    const block = localization.buildCanonicalNamesBlock('s1');
    expect(block).not.toMatch(/ent-wei-chen/);
    expect(block).not.toMatch(/locked/);
    expect(block).not.toMatch(/userApproved/);
  });
});

// ── 10. Coherence recognises aliases as the same entity ────────────────────
// (Exercised via resolveNameWithMap — the same function coherence uses.)

describe('localization alias-aware identity (coherence contract)', () => {
  const MAP = {
    entities: [
      { sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', displayName: 'Cedric Vale' },
      { sourceNames: ['Lin Yue'], canonicalName: 'Isabella Hart', displayName: 'Isabella Hart' },
    ],
  };

  it('source name and canonical name resolve to the SAME display name', () => {
    expect(localization.resolveNameWithMap(MAP, 'Wei Chen'))
      .toBe(localization.resolveNameWithMap(MAP, 'Cedric Vale'));
  });

  it('two different characters resolve to DIFFERENT display names', () => {
    expect(localization.resolveNameWithMap(MAP, 'Wei Chen'))
      .not.toBe(localization.resolveNameWithMap(MAP, 'Lin Yue'));
  });
});

// ── 12. TTS-friendly names are accepted ─────────────────────────────────────

describe('localization accepts TTS-friendly (simple, pronounceable) names', () => {
  beforeEach(() => {
    storyRag.getEntityMapDoc.mockReturnValue(null);
    storyRag._slugify.mockImplementation((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  });

  const ttsFriendly = ['Cedric Vale', 'Isabella Hart', 'Westmere', 'Meridian Holdings', 'Julian Mercer'];
  for (const name of ttsFriendly) {
    it(`accepts "${name}"`, () => {
      const { entity } = localization.addOrUpdateMapping('s1', {
        entityType: 'character', sourceName: 'Source ' + name, canonicalName: name,
      });
      expect(entity.canonicalName).toBe(name);
    });
  }
});

// ── LLM-driven localization ────────────────────────────────────────────────

describe('localization.parseLocalizeResponse', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({ mappings: [
      { sourceName: 'Wei Chen', entityType: 'character', canonicalName: 'Cedric Vale' },
      { sourceName: 'Jiangnan', entityType: 'place', canonicalName: 'Westmere' },
    ]});
    const out = localization.parseLocalizeResponse(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ sourceName: 'Wei Chen', entityType: 'character', canonicalName: 'Cedric Vale' });
  });

  it('tolerates prose around the JSON', () => {
    const raw = 'Here are the names:\n{"mappings":[{"sourceName":"Wei Chen","entityType":"character","canonicalName":"Cedric Vale"}]}\nDone.';
    const out = localization.parseLocalizeResponse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].canonicalName).toBe('Cedric Vale');
  });

  it('returns [] for unparseable input', () => {
    expect(localization.parseLocalizeResponse('no json here')).toEqual([]);
    expect(localization.parseLocalizeResponse('')).toEqual([]);
  });

  it('drops mappings missing required string fields', () => {
    const raw = JSON.stringify({ mappings: [
      { sourceName: 'Wei Chen', canonicalName: 'Cedric Vale' },
      { sourceName: '', canonicalName: 'X' },
      { sourceName: 'Y' },
    ]});
    const out = localization.parseLocalizeResponse(raw);
    // Only the first has both non-empty source + canonical; entityType defaults.
    expect(out).toHaveLength(1);
    expect(out[0].entityType).toBe('character');
  });
});

describe('localization.localizeStory', () => {
  beforeEach(() => {
    storyRag._slugify.mockImplementation((s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
  });

  it('returns localized:false when localization is not enabled', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'original' });
    const res = await localization.localizeStory('s1', {});
    expect(res.localized).toBe(false);
    expect(ai.ask).not.toHaveBeenCalled();
  });

  it('localizes unmapped entities via a single LLM call and stores them', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.listDocs.mockImplementation((id, type) => {
      if (type === 'character') return [{ name: 'Wei Chen' }, { name: 'Lin Yue' }];
      if (type === 'lore') return [{ title: 'Longhe Group' }];
      return [];
    });
    storyRag.getEntityMapDoc.mockReturnValue({ entities: [] });
    ai.ask.mockResolvedValue(JSON.stringify({ mappings: [
      { sourceName: 'Wei Chen', entityType: 'character', canonicalName: 'Cedric Vale' },
      { sourceName: 'Lin Yue', entityType: 'character', canonicalName: 'Isabella Hart' },
      { sourceName: 'Longhe Group', entityType: 'company', canonicalName: 'Meridian Holdings' },
    ]}));

    const res = await localization.localizeStory('s1', { model: 'gemma3' });
    expect(res.localized).toBe(true);
    expect(res.added).toHaveLength(3);
    expect(ai.ask).toHaveBeenCalledTimes(1);
    // Model is forwarded into the localization call.
    expect(ai.ask.mock.calls[0][1]).toEqual(expect.objectContaining({ model: 'gemma3' }));
  });

  it('skips entities already mapped (no re-naming)', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.listDocs.mockImplementation((id, type) => {
      if (type === 'character') return [{ name: 'Wei Chen' }];
      return [];
    });
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{ sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale', displayName: 'Cedric Vale' }],
    });
    const res = await localization.localizeStory('s1', {});
    expect(res.localized).toBe(true);
    expect(res.added).toEqual([]);
    expect(ai.ask).not.toHaveBeenCalled();
  });

  it('soft-fails (localized:false + error) when the LLM is unreachable', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.listDocs.mockImplementation((id, type) => {
      if (type === 'character') return [{ name: 'Wei Chen' }];
      return [];
    });
    storyRag.getEntityMapDoc.mockReturnValue({ entities: [] });
    ai.ask.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await localization.localizeStory('s1', {});
    expect(res.localized).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });
});

describe('localization.localizeEntities (newly discovered entities)', () => {
  it('is a no-op when localization is inactive', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'original' });
    const res = await localization.localizeEntities('s1', [{ name: 'Wei Chen', type: 'character' }], {});
    expect(res.localized).toBe(false);
    expect(res.skipped).toBe(true);
  });

  it('skips when all provided names are already mapped', async () => {
    storyRag.getLocalizationConfig.mockReturnValue({ style: 'english_distinctive' });
    storyRag.getEntityMapDoc.mockReturnValue({
      entities: [{ sourceNames: ['Wei Chen'], canonicalName: 'Cedric Vale' }],
    });
    const res = await localization.localizeEntities('s1', [{ name: 'Wei Chen', type: 'character' }], {});
    expect(res.skipped).toBe(true);
    expect(ai.ask).not.toHaveBeenCalled();
  });
});

// ── 11. Existing stories continue working without localization ─────────────

describe('localization backward compatibility (no localization configured)', () => {
  it('isActive is false and buildCanonicalNamesBlock returns "" for a legacy story', () => {
    storyRag.getLocalizationConfig.mockReturnValue(null);
    storyRag.getEntityMap.mockReturnValue([]);
    expect(localization.isActive('legacy')).toBe(false);
    expect(localization.buildCanonicalNamesBlock('legacy')).toBe('');
  });

  it('resolveNameWithMap returns the original name when no map exists', () => {
    expect(localization.resolveNameWithMap(null, 'Wei Chen')).toBe('Wei Chen');
  });
});

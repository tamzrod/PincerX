'use strict';

/**
 * Name & Place Localization — canonical identity system.
 *
 * ===========================================================================
 * PURPOSE
 * ===========================================================================
 * Allow a story generated from Chinese/Asian-style (or any non-English)
 * source material to use distinctive English-readable names and places
 * CONSISTENTLY throughout the entire serialized story.
 *
 * This is NOT text replacement. It is an identity/canonicalization system:
 *
 *   SOURCE ENTITY  →  CANONICAL ENTITY  →  STORY KNOWLEDGE (RAG)  →  ALL FUTURE GENERATION
 *
 * The Story Writer owns identity. The LLM may SUGGEST names; the LLM does NOT
 * own canonical identity. Once a canonical name is assigned it is the single
 * source of truth injected into every generation/regeneration prompt, and
 * coherence recognises source-name aliases as the SAME entity.
 *
 * ===========================================================================
 * STORAGE
 * ===========================================================================
 * A single per-story RAG doc of type 'entity_map' (id 'entity-map') holds
 * BOTH the author-intent config (style) and the canonical entity mappings.
 * This reuses the existing Story Knowledge / RAG architecture — there is no
 * second storage system. See story/story-rag.js#getEntityMapDoc.
 *
 * Mapping shape:
 *   {
 *     id:           'ent-<slug>',           // stable entity id
 *     entityType:   'character' | 'place' | 'organization' | ...,
 *     sourceNames:  ['Wei Chen'],            // original/source names (aliases)
 *     canonicalName:'Cedric Vale',           // the single canonical identity
 *     displayName:  'Cedric Vale',           // name used in prose (== canonical)
 *     userApproved: false,                   // author approved this mapping
 *     locked:       false                    // author locked it — never auto-change
 *   }
 *
 * ===========================================================================
 * SOFT-FAIL
 * ===========================================================================
 * Localization NEVER blocks chapter generation. Synthesis/localization LLM
 * failures are swallowed (with an `error` surfaced on the result) and the
 * previous entity map is preserved. An unreachable LLM is reported via
 * `error` — do NOT mock Ollama to reproduce it.
 * ===========================================================================
 */

const ai = require('../lib/ai');
const storyRag = require('./story-rag');

// ── Author-intent vocabulary (machine ids + display labels) ─────────────────

/**
 * Localization styles. Values are stable machine-readable ids; display labels
 * (for the UI + error messages) live in STYLE_LABELS.
 */
const LOCALIZATION_STYLES = [
  'original',            // preserve source names (default — existing behaviour)
  'english',             // use English-readable names
  'english_distinctive', // English-readable, avoid highly common names
  'custom',              // author supplies mappings manually
];

const STYLE_LABELS = {
  original: 'Original',
  english: 'English',
  english_distinctive: 'English — Distinctive',
  custom: 'Custom',
};

/**
 * Default config. `original` preserves existing behaviour unless the author
 * explicitly enables localization — stories that pre-date the feature are
 * unaffected.
 */
const DEFAULT_CONFIG = { style: 'original' };

/**
 * Small, configurable list of commonly overused English names to AVOID when
 * the style is `english_distinctive`. This is deliberately NOT an enormous
 * blacklist — the localization model is instructed to pick less-common but
 * natural English names, with this list as a hint of what to steer away from.
 */
const COMMON_NAMES = [
  'Ethan', 'Liam', 'Noah', 'James', 'Michael', 'Daniel', 'David', 'John',
  'Robert', 'Joseph', 'Andrew', 'Chris', 'Matthew', 'Tyler',
  'Emma', 'Olivia', 'Sophia', 'Isabella', 'Charlotte', 'Amelia', 'Mia',
  'Emily', 'Abigail', 'Madison', 'Elizabeth', 'Sarah',
];

/**
 * Entity kinds the system can localize. `entityType` is a free string on a
 * mapping (so the model can be specific), but this list is the canonical
 * vocabulary surfaced to the LLM and UI. Maps onto the existing RAG types
 * (character / place / lore / system) where possible.
 */
const ENTITY_TYPES = [
  'character',
  'place',
  'city',
  'country',
  'company',
  'organization',
  'school',
  'university',
  'hospital',
  'clan',
  'sect',
  'military',
  'kingdom',
  'district',
  'business',
];

const ENTITY_TYPE_LABELS = {
  character: 'Character',
  place: 'Place',
  city: 'City',
  country: 'Country / Region',
  company: 'Company',
  organization: 'Organization',
  school: 'School',
  university: 'University',
  hospital: 'Hospital',
  clan: 'Clan',
  sect: 'Sect',
  military: 'Military Organization',
  kingdom: 'Fictional Kingdom',
  district: 'Fictional District',
  business: 'Business',
};

// ── Config validation ───────────────────────────────────────────────────────

/**
 * Normalise a style value to a machine id. Accepts the machine id OR the
 * display label (case-insensitive) at the boundary.
 *
 * @param {string} value
 * @returns {string|null}
 */
function _canonicalizeStyle(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (LOCALIZATION_STYLES.includes(v)) return v;
  // Accept display labels (e.g. "English — Distinctive", "English - Distinctive").
  for (const id of LOCALIZATION_STYLES) {
    if (STYLE_LABELS[id].toLowerCase().replace(/\s+[—-]\s+/g, '_') === v.replace(/\s+[—-]\s+/g, '_')) {
      return id;
    }
    if (STYLE_LABELS[id].toLowerCase() === v) return id;
  }
  return null;
}

/**
 * Validate a Name & Place Localization config object. Returns
 * `{ valid, errors, normalized }`. Always normalises to machine ids.
 *
 * @param {object} config
 * @returns {{ valid: boolean, errors: string[], normalized: object|null }}
 */
function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object.'], normalized: null };
  }
  const style = _canonicalizeStyle(config.style);
  if (!style) {
    errors.push(`Invalid style. Expected one of: ${LOCALIZATION_STYLES.map((s) => STYLE_LABELS[s]).join(', ')}.`);
  }
  if (errors.length) return { valid: false, errors, normalized: null };
  return { valid: true, errors: [], normalized: { style } };
}

/**
 * True when localization is active for a story — i.e. a config is stored AND
 * the style is not `original`. When inactive, all generation/coherence paths
 * behave exactly as before (backward compatible).
 *
 * @param {string} storyId
 * @returns {boolean}
 */
function isActive(storyId) {
  const config = storyRag.getLocalizationConfig(storyId);
  return Boolean(config && config.style && config.style !== 'original');
}

// ── Entity map access ───────────────────────────────────────────────────────

/**
 * Load the full entity map doc (config + entities) for a story, or null.
 * @param {string} storyId
 * @returns {object|null}
 */
function loadEntityMap(storyId) {
  return storyRag.getEntityMapDoc(storyId);
}

/**
 * Get the canonical entity mappings array for a story ([] when none).
 * @param {string} storyId
 * @returns {Array<object>}
 */
function listEntities(storyId) {
  return storyRag.getEntityMap(storyId);
}

/**
 * Persist the entities array (preserves the stored config).
 * @param {string} storyId
 * @param {Array<object>} entities
 * @returns {Array<object>} the persisted entities.
 */
function saveEntities(storyId, entities) {
  storyRag.saveEntityMapDoc(storyId, { entities });
  return entities;
}

// ── Alias / name resolution ─────────────────────────────────────────────────

/**
 * Find the entity for a name (case-insensitive), matching against BOTH
 * sourceNames (aliases) AND the canonicalName/displayName. Returns the entity
 * or null. Works against a loaded map object so callers can avoid re-reading
 * disk for every lookup.
 *
 * @param {object|null} mapDoc - A loaded entity_map doc (or null).
 * @param {string} name
 * @returns {object|null}
 */
function findEntity(mapDoc, name) {
  if (!mapDoc || !Array.isArray(mapDoc.entities) || !name) return null;
  const needle = String(name).trim().toLowerCase();
  if (!needle) return null;
  for (const ent of mapDoc.entities) {
    const candidates = []
      .concat(ent.sourceNames || [])
      .concat(ent.canonicalName ? [ent.canonicalName] : [])
      .concat(ent.displayName ? [ent.displayName] : [])
      .map((s) => String(s).trim().toLowerCase());
    if (candidates.includes(needle)) return ent;
  }
  return null;
}

/**
 * Resolve a name to its canonical (display) name. If the name is a known
 * source-name alias OR already a canonical name, the canonical displayName is
 * returned. Otherwise the original name is returned unchanged. This is how
 * coherence recognises that "Wei Chen" and "Cedric Vale" are the SAME entity.
 *
 * @param {object|null} mapDoc
 * @param {string} name
 * @returns {string}
 */
function resolveNameWithMap(mapDoc, name) {
  const ent = findEntity(mapDoc, name);
  if (!ent) return name;
  return ent.displayName || ent.canonicalName || name;
}

/**
 * Convenience: load the map from disk then resolve. Use resolveNameWithMap
 * when you already hold the map (e.g. inside one generation pass).
 *
 * @param {string} storyId
 * @param {string} name
 * @returns {string}
 */
function resolveName(storyId, name) {
  return resolveNameWithMap(loadEntityMap(storyId), name);
}

// ── Mapping management ──────────────────────────────────────────────────────

/**
 * Generate a stable entity id from a source name.
 * @param {string} sourceName
 * @returns {string}
 */
function _entityId(sourceName) {
  const slug = storyRag._slugify(sourceName) || 'entity';
  return `ent-${slug}`;
}

/**
 * Add or update a canonical mapping. Rules:
 *  - If a mapping for the sourceName already exists, update its canonicalName
 *    (unless it is locked AND the caller is not the user — see `userApproved`).
 *  - Prevent DUPLICATE canonical names: no two entities may share the same
 *    canonicalName (case-insensitive) unless they are the same entity.
 *  - `userApproved`/`locked` mark an authoritative mapping the system must not
 *    silently change.
 *
 * @param {string} storyId
 * @param {object} entry - { entityType, sourceName, canonicalName, userApproved?, locked? }
 * @returns {{ entity: object, created: boolean }}
 */
function addOrUpdateMapping(storyId, entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('Mapping entry is required.');
  }
  const sourceName = typeof entry.sourceName === 'string' ? entry.sourceName.trim() : '';
  const canonicalName = typeof entry.canonicalName === 'string' ? entry.canonicalName.trim() : '';
  if (!sourceName) throw new TypeError('sourceName is required.');
  if (!canonicalName) throw new TypeError('canonicalName is required.');

  const mapDoc = loadEntityMap(storyId) || {
    id: storyRag.ENTITY_MAP_DOC_ID,
    type: 'entity_map',
    config: { style: 'english_distinctive' },
    entities: [],
  };
  const entities = Array.isArray(mapDoc.entities) ? mapDoc.entities.slice() : [];

  const canonicalLower = canonicalName.toLowerCase();
  // Duplicate canonical name check (across OTHER entities).
  const dup = entities.find(
    (e) => (e.canonicalName || '').toLowerCase() === canonicalLower &&
      !(e.sourceNames || []).map((s) => s.toLowerCase()).includes(sourceName.toLowerCase())
  );
  if (dup) {
    throw new Error(`Canonical name "${canonicalName}" is already assigned to another entity (${(dup.sourceNames || [])[0] || dup.canonicalName}).`);
  }

  const idx = entities.findIndex(
    (e) => (e.sourceNames || []).map((s) => s.toLowerCase()).includes(sourceName.toLowerCase()) ||
      (e.canonicalName || '').toLowerCase() === sourceName.toLowerCase()
  );

  let entity;
  let created = false;
  if (idx >= 0) {
    entity = entities[idx];
    // Respect locked mappings: only a user-approved update (userApproved:true)
    // may change a locked canonical name.
    if (entity.locked && !entry.userApproved) {
      // Leave the canonical name as-is; still merge metadata.
      entity = { ...entity, entityType: entry.entityType || entity.entityType };
    } else {
      entity = {
        ...entity,
        entityType: entry.entityType || entity.entityType,
        canonicalName,
        displayName: canonicalName,
        userApproved: entry.userApproved === true ? true : entity.userApproved,
        locked: entry.locked === true ? true : entity.locked,
      };
    }
    entities[idx] = entity;
  } else {
    entity = {
      id: _entityId(sourceName),
      entityType: entry.entityType || 'character',
      sourceNames: [sourceName],
      canonicalName,
      displayName: canonicalName,
      userApproved: Boolean(entry.userApproved),
      locked: Boolean(entry.locked),
    };
    entities.push(entity);
    created = true;
  }

  saveEntities(storyId, entities);
  return { entity, created };
}

/**
 * Remove a mapping by entity id. Returns true if removed.
 * @param {string} storyId
 * @param {string} entityId
 * @returns {boolean}
 */
function removeMapping(storyId, entityId) {
  const entities = listEntities(storyId);
  const idx = entities.findIndex((e) => e.id === entityId);
  if (idx < 0) return false;
  entities.splice(idx, 1);
  saveEntities(storyId, entities);
  return true;
}

// ── Prompt block ────────────────────────────────────────────────────────────

/**
 * Build the CANONICAL NAMES block injected into chapter / regeneration /
 * resume prompts. Lists each mapping as `sourceName → canonicalName` with an
 * explicit "Use \"X\" in all generated prose." instruction. Does NOT expose
 * internal implementation details (ids, locked flags, etc.) to the model.
 *
 * Returns '' when localization is inactive or no mappings exist, so the prompt
 * is unchanged for stories that don't use the feature.
 *
 * @param {string} storyId
 * @returns {string}
 */
function buildCanonicalNamesBlock(storyId) {
  if (!isActive(storyId)) return '';
  const entities = listEntities(storyId);
  if (!entities.length) return '';
  const lines = entities.map((ent) => {
    const source = (ent.sourceNames || [])[0] || ent.canonicalName;
    return `${source}\n→ ${ent.canonicalName}\nUse "${ent.canonicalName}" in all generated prose.`;
  });
  return [
    '═══════════════════════════════════════════════════════════════',
    'CANONICAL NAMES — use these names consistently in all prose',
    '═══════════════════════════════════════════════════════════════',
    '',
    lines.join('\n\n'),
    '',
    'These source names and their canonical names refer to the SAME entity.',
    'Always use the canonical name. Do NOT revert to the source name or invent',
    'a new name for an entity that already has a canonical name.',
    '═══════════════════════════════════════════════════════════════',
  ].join('\n');
}

// ── LLM-driven localization ─────────────────────────────────────────────────

/**
 * Strip streaming/transport-only hooks so the localization LLM call honours
 * the UI-selected model + provider without carrying generation-only options.
 * Mirrors story-experience.js#_cleanAiOptions.
 *
 * @param {object} aiOptions
 * @returns {object}
 */
function _cleanAiOptions(aiOptions) {
  if (!aiOptions || typeof aiOptions !== 'object') return {};
  const out = {};
  for (const key of ['model', 'provider', 'apiKey', 'baseUrl', 'timeoutMs']) {
    if (aiOptions[key] !== undefined) out[key] = aiOptions[key];
  }
  return out;
}

/**
 * Build the LLM prompt for proposing canonical names for a set of source
 * entities. Kept separate so it can be unit-tested.
 *
 * @param {object} ctx
 * @param {Array<{name:string,type:string}>} ctx.entities - source entities to name.
 * @param {string} ctx.style - machine id style.
 * @param {Array<object>} ctx.existing - already-mapped entities (to avoid collisions).
 * @returns {string}
 */
function _buildLocalizePrompt(ctx) {
  const { entities, style, existing } = ctx;
  const distinctive = style === 'english_distinctive';
  const entityLines = entities.map((e) => `- ${e.name} (${e.type})`).join('\n');
  const existingLines = (existing && existing.length)
    ? existing.map((e) => `- ${(e.sourceNames || [])[0] || e.canonicalName} → ${e.canonicalName}`).join('\n')
    : '(none)';

  return [
    'You are a localization specialist for a serialized audio story.',
    'Assign distinctive, memorable, English-readable canonical names to the entities below.',
    'Preserve entity identity, relationships, gender (where established), and important',
    'naming distinctions. Localize characters, places, companies, organizations, clans,',
    'sects, schools, and other named entities as appropriate.',
    '',
    distinctive
      ? 'Style: English — Distinctive. Pick less-common but NATURAL English names.'
      : 'Style: English. Pick natural, English-readable names.',
    distinctive
      ? `AVOID these overused names: ${COMMON_NAMES.join(', ')}.`
      : '',
    distinctive
      ? 'Names must be: easy to read + easy to pronounce in English TTS + distinctive + memorable.'
      : 'Names must be easy to read and pronounce in English TTS.',
    'Do NOT pick deliberately bizarre names merely to be unique. Names should sound plausible.',
    'Do NOT change the entity\'s role, gender, or relationships — only the name.',
    'Each entity must receive a UNIQUE canonical name (no two entities share a name).',
    '',
    'Entities to name:',
    entityLines,
    '',
    'Already-assigned canonical names (do not reuse or collide with these):',
    existingLines,
    '',
    'Respond with ONLY a valid JSON object:',
    '{',
    '  "mappings": [',
    '    { "sourceName": "...", "entityType": "character", "canonicalName": "..." }',
    '  ]',
    '}',
    'Return one mapping per input entity. entityType should be one of: ' +
      ENTITY_TYPES.join(', ') + '.',
  ].filter(Boolean).join('\n');
}

/**
 * Parse the LLM localization response into a mappings array. Tolerates prose
 * around the JSON and literal newlines inside string values.
 *
 * @param {string} raw
 * @returns {Array<object>}
 */
function parseLocalizeResponse(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    try {
      parsed = JSON.parse(match[0].replace(/\r?\n/g, '\\n'));
    } catch {
      return [];
    }
  }
  if (!parsed || !Array.isArray(parsed.mappings)) return [];
  return parsed.mappings
    .filter((m) => m && typeof m.sourceName === 'string' && typeof m.canonicalName === 'string'
      && m.sourceName.trim() && m.canonicalName.trim())
    .map((m) => ({
      sourceName: m.sourceName.trim(),
      canonicalName: m.canonicalName.trim(),
      entityType: typeof m.entityType === 'string' && m.entityType.trim() ? m.entityType.trim() : 'character',
    }));
}

/**
 * Scan existing story knowledge (characters, places, lore, systems) and
 * propose canonical names for any source names not already mapped. This is
 * the explicit "Localize Story Names" operation for existing stories. It does
 * NOT rewrite historical chapters — only future generation context is updated.
 *
 * Soft-fails: on LLM error, returns `{ localized:false, error }` and the
 * existing entity map is left untouched.
 *
 * @param {string} storyId
 * @param {object} aiOptions - Model/provider forwarded from the story flow.
 * @returns {Promise<{ localized:boolean, entities?:Array, added?:Array, error?:string }>}
 */
async function localizeStory(storyId, aiOptions = {}) {
  const config = storyRag.getLocalizationConfig(storyId);
  if (!config || !config.style || config.style === 'original') {
    return { localized: false, error: 'Localization is not enabled for this story.' };
  }

  // Gather source entities from the existing RAG knowledge base.
  const sourceEntities = [];
  const pushUnique = (name, type) => {
    if (!name || sourceEntities.some((e) => e.name.toLowerCase() === name.toLowerCase())) return;
    sourceEntities.push({ name, type });
  };
  for (const c of (storyRag.listDocs(storyId, 'character') || [])) {
    if (c.name) pushUnique(c.name, 'character');
  }
  for (const p of (storyRag.listDocs(storyId, 'place') || [])) {
    if (p.title) pushUnique(p.title, 'place');
  }
  for (const l of (storyRag.listDocs(storyId, 'lore') || [])) {
    if (l.title) pushUnique(l.title, l.title.toLowerCase().includes('company') || l.title.toLowerCase().includes('group') ? 'company' : 'place');
  }
  for (const s of (storyRag.listDocs(storyId, 'system') || [])) {
    if (s.title) pushUnique(s.title, 'organization');
  }

  // Skip names already mapped.
  const mapDoc = loadEntityMap(storyId);
  const existing = (mapDoc && mapDoc.entities) || [];
  const unmapped = sourceEntities.filter(
    (e) => !findEntity(mapDoc, e.name)
  );
  if (!unmapped.length) {
    return { localized: true, entities: existing, added: [] };
  }

  const prompt = _buildLocalizePrompt({ entities: unmapped, style: config.style, existing });
  const locOptions = _cleanAiOptions(aiOptions);

  let raw;
  try {
    raw = await ai.ask(prompt, locOptions);
  } catch (e) {
    return { localized: false, error: e.message, entities: existing };
  }

  const mappings = parseLocalizeResponse(raw);
  if (!mappings.length) {
    return { localized: false, error: 'Localization model returned no mappings.', entities: existing };
  }

  const added = [];
  for (const m of mappings) {
    try {
      const { entity } = addOrUpdateMapping(storyId, {
        entityType: m.entityType,
        sourceName: m.sourceName,
        canonicalName: m.canonicalName,
      });
      added.push(entity);
    } catch (e) {
      // Skip a colliding/invalid mapping rather than failing the whole batch.
    }
  }

  return { localized: true, entities: listEntities(storyId), added };
}

/**
 * Localize a set of NEWLY discovered entity names (e.g. characters extracted
 * from a freshly generated chapter). A single batched LLM call proposes names
 * for all unmapped names at once, so the model is never asked to rename the
 * same character every chapter.
 *
 * No-op (returns `{ localized:false, skipped:true }`) when localization is
 * inactive or no unmapped names are provided.
 *
 * @param {string} storyId
 * @param {Array<{name:string,type:string}>} sourceEntities
 * @param {object} aiOptions
 * @returns {Promise<object>}
 */
async function localizeEntities(storyId, sourceEntities = [], aiOptions = {}) {
  if (!isActive(storyId)) return { localized: false, skipped: true };
  if (!Array.isArray(sourceEntities) || !sourceEntities.length) {
    return { localized: false, skipped: true };
  }
  const mapDoc = loadEntityMap(storyId);
  const existing = (mapDoc && mapDoc.entities) || [];
  const unmapped = sourceEntities.filter((e) => e && e.name && !findEntity(mapDoc, e.name));
  if (!unmapped.length) return { localized: false, skipped: true };

  const config = storyRag.getLocalizationConfig(storyId);
  const prompt = _buildLocalizePrompt({ entities: unmapped, style: config.style, existing });
  const locOptions = _cleanAiOptions(aiOptions);

  let raw;
  try {
    raw = await ai.ask(prompt, locOptions);
  } catch (e) {
    return { localized: false, error: e.message };
  }
  const mappings = parseLocalizeResponse(raw);
  const added = [];
  for (const m of mappings) {
    try {
      const { entity } = addOrUpdateMapping(storyId, {
        entityType: m.entityType,
        sourceName: m.sourceName,
        canonicalName: m.canonicalName,
      });
      added.push(entity);
    } catch { /* skip collisions */ }
  }
  return { localized: true, added };
}

module.exports = {
  LOCALIZATION_STYLES,
  STYLE_LABELS,
  DEFAULT_CONFIG,
  COMMON_NAMES,
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  validateConfig,
  isActive,
  loadEntityMap,
  listEntities,
  saveEntities,
  findEntity,
  resolveName,
  resolveNameWithMap,
  addOrUpdateMapping,
  removeMapping,
  buildCanonicalNamesBlock,
  localizeStory,
  localizeEntities,
  parseLocalizeResponse,
};

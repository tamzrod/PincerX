'use strict';

const fs = require('fs');
const path = require('path');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

/**
 * Allowed pattern for story IDs — matches the same rule enforced by the API
 * layer (STORY_ID_RE in server.js).  Validated here as defence-in-depth so
 * that story-rag.js cannot be used to construct paths outside STORIES_DIR even
 * if it were called from code that skips the server-level check.
 */
const VALID_STORY_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Valid knowledge document types for per-story knowledge store.
 * Each type supports additional fields beyond the base schema.
 *
 * Schema for all types:
 * - id: string (required)
 * - type: string (required, one of VALID_TYPES)
 * - title: string (optional)
 * - content: string (optional)
 * - context: string (optional, KDE-Beta: conditions under which this is true)
 * - boundary: string (optional, KDE-Beta: when this stops being true)
 * - sourceChapter: number (optional, chapter that established this)
 * - confidence: number (optional, 0-1)
 *
 * Type-specific fields:
 * - character: name, role, gender, personality, backstory, speechStyle, voiceId
 * - place: description, constraints
 * - lore/world: description
 * - system: description, domain (tech|magic|cultivation|science)
 * - parameter: genre, tone, bans
 * - arc_boundary: phase, constraints, allowedEvents, forbiddenEvents
 * - summary: chapterNumber, content
 * - reader_experience: config, currentState, readerQuestions, knowledgeManagement,
 *   trajectory, lastChapterNumber, lastObjective, lastFindings (evolving Reader
 *   Experience state — see story/story-experience.js)
 * - entity_map: config (Name & Place Localization style), entities (canonical
 *   identity mappings — see story/story-localization.js). Single doc per story.
 */
const VALID_TYPES = [
  'character',
  'place',
  'lore',
  'world',
  'system',
  'parameter',
  'arc_boundary',
  'summary',
  'reader_experience',
  'entity_map',
];

/**
 * Slugify a string to a safe identifier.
 * @param {string} str
 * @returns {string}
 */
function _slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Throw a TypeError when storyId does not match the allowed pattern.
 * Prevents path-traversal attacks by ensuring storyId cannot contain path
 * separators or relative segments.
 *
 * @param {string} storyId
 */
function _assertValidStoryId(storyId) {
  if (
    !storyId ||
    typeof storyId !== 'string' ||
    !VALID_STORY_ID_RE.test(storyId)
  ) {
    throw new TypeError(`Invalid story ID: "${storyId}"`);
  }
}

/**
 * Validate a knowledge document type.
 * @param {string} type
 * @returns {boolean}
 */
function isValidType(type) {
  return VALID_TYPES.includes(type);
}

/**
 * Return the absolute path to the per-story RAG docs file.
 *
 * @param {string} storyId - Already-validated story ID.
 * @returns {string}
 */
function _docsPath(storyId) {
  // Use path.basename to strip any directory separators that might escape STORIES_DIR,
  // mirroring the same defence used in story.js (path.basename(`${storyId}.json`)).
  return path.join(STORIES_DIR, path.basename(storyId), 'rag-docs.json');
}

/**
 * Load all RAG documents for a story from disk.
 * Returns an empty array when the file does not exist yet.
 *
 * @param {string} storyId
 * @returns {Array<object>}
 */
function loadDocs(storyId) {
  try {
    return JSON.parse(fs.readFileSync(_docsPath(storyId), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Persist the doc array for a story to disk.
 *
 * @param {string} storyId
 * @param {Array<object>} docs
 */
function saveDocs(storyId, docs) {
  const dir = path.join(STORIES_DIR, path.basename(storyId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_docsPath(storyId), JSON.stringify(docs, null, 2), 'utf8');
}

/**
 * Add or update a document in the story's RAG store.
 * If a document with the same id already exists, it is replaced.
 *
 * @param {string} storyId
 * @param {object} doc - Must include an `id` string field.
 */
function addDoc(storyId, doc) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  const idx = docs.findIndex((d) => d.id === doc.id);
  if (idx >= 0) {
    docs[idx] = doc;
  } else {
    docs.push(doc);
  }
  saveDocs(storyId, docs);
}

/**
 * Remove a document by id from the story's RAG store.
 * Returns true if the document was found and removed, false otherwise.
 *
 * @param {string} storyId
 * @param {string} docId
 * @returns {boolean}
 */
function removeDoc(storyId, docId) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx < 0) return false;
  docs.splice(idx, 1);
  saveDocs(storyId, docs);
  return true;
}

/**
 * List documents of a specific type ('character', 'lore', 'summary') or all
 * documents when type is omitted.
 *
 * @param {string} storyId
 * @param {string} [type]
 * @returns {Array<object>}
 */
function listDocs(storyId, type) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  return type ? docs.filter((d) => d.type === type) : docs;
}

/**
 * Keyword-based retrieval from a story's RAG documents.
 * Scores each document by counting how many query keywords appear in its
 * searchable text fields (title, name, content).
 *
 * @param {string} storyId
 * @param {string} query
 * @param {number} [topK=5]
 * @returns {Array<object>}
 */
function retrieve(storyId, query, topK = 5) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (!keywords.length) return [];

  const scored = docs.map((doc) => {
    const haystack = [doc.title, doc.name, doc.content]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const score = keywords.reduce((acc, kw) => {
      const matches = (haystack.match(new RegExp(kw, 'g')) || []).length;
      return acc + matches;
    }, 0);
    return { doc, score };
  });

  return scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ doc }) => doc);
}

/**
 * Remove the per-story RAG docs file and its directory (if empty).
 * Called when a story is deleted to clean up associated metadata.
 *
 * @param {string} storyId
 */
function clearStory(storyId) {
  _assertValidStoryId(storyId);
  const safeId = path.basename(storyId);
  const dir = path.join(STORIES_DIR, safeId);
  if (!fs.existsSync(dir)) return;
  const p = path.join(dir, 'rag-docs.json');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // Remove the directory only when empty.  Only ENOTEMPTY and ENOENT are
  // expected here; any other error (e.g. EACCES, EIO) is re-thrown.
  try {
    fs.rmdirSync(dir);
  } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') throw e;
  }
}

/**
 * Get a document by its ID.
 *
 * @param {string} storyId
 * @param {string} docId
 * @returns {object|null}
 */
function getDoc(storyId, docId) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  return docs.find((d) => d.id === docId) || null;
}

/**
 * List all documents grouped by type.
 *
 * @param {string} storyId
 * @returns {Object<string, Array>} Documents grouped by type
 */
function listDocsByType(storyId) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);
  const grouped = {};
  for (const type of VALID_TYPES) {
    grouped[type] = docs.filter((d) => d.type === type);
  }
  return grouped;
}

/**
 * Add or update a knowledge document with merge support.
 * If a document with the same title (for lore/place/system) or name (for character)
 * exists, it updates; otherwise it adds new.
 *
 * @param {string} storyId
 * @param {object} doc - Must include id, type, and either name or title
 * @returns {boolean} true if added, false if updated
 */
function upsertKnowledge(storyId, doc) {
  _assertValidStoryId(storyId);
  const docs = loadDocs(storyId);

  // Find by id first
  const idx = docs.findIndex((d) => d.id === doc.id);
  if (idx >= 0) {
    docs[idx] = { ...docs[idx], ...doc, updatedAt: new Date().toISOString() };
    saveDocs(storyId, docs);
    return false;
  }

  // If no id match, try finding by name (for characters) or title (for others)
  if (doc.name) {
    const nameIdx = docs.findIndex(
      (d) => d.type === doc.type && d.name && d.name.toLowerCase() === doc.name.toLowerCase()
    );
    if (nameIdx >= 0) {
      docs[nameIdx] = { ...docs[nameIdx], ...doc, updatedAt: new Date().toISOString() };
      saveDocs(storyId, docs);
      return false;
    }
  }

  if (doc.title) {
    const titleIdx = docs.findIndex(
      (d) => d.type === doc.type && d.title && d.title.toLowerCase() === doc.title.toLowerCase()
    );
    if (titleIdx >= 0) {
      docs[titleIdx] = { ...docs[titleIdx], ...doc, updatedAt: new Date().toISOString() };
      saveDocs(storyId, docs);
      return false;
    }
  }

  // Not found, add new
  docs.push({ ...doc, createdAt: new Date().toISOString() });
  saveDocs(storyId, docs);
  return true;
}

/**
 * Batch add or update multiple documents efficiently.
 *
 * @param {string} storyId
 * @param {Array<object>} docs
 */
function batchUpsert(storyId, docs) {
  _assertValidStoryId(storyId);
  const existing = loadDocs(storyId);
  const existingMap = new Map(existing.map((d) => [d.id, d]));

  for (const doc of docs) {
    if (doc.id && existingMap.has(doc.id)) {
      // Update existing
      existingMap.set(doc.id, { ...existingMap.get(doc.id), ...doc, updatedAt: new Date().toISOString() });
    } else {
      // Add new with dedup by name/title
      const nameMatch = doc.name
        ? existing.find((d) => d.type === doc.type && d.name && d.name.toLowerCase() === doc.name.toLowerCase())
        : null;
      const titleMatch = doc.title
        ? existing.find((d) => d.type === doc.type && d.title && d.title.toLowerCase() === doc.title.toLowerCase())
        : null;
      const match = nameMatch || titleMatch;
      if (match) {
        existingMap.set(match.id, { ...match, ...doc, updatedAt: new Date().toISOString() });
      } else {
        existingMap.set(doc.id, { ...doc, createdAt: new Date().toISOString() });
      }
    }
  }

  saveDocs(storyId, [...existingMap.values()]);
}

/**
 * Format knowledge documents for injection into chapter prompts.
 * Returns a human-readable string suitable for AI context.
 *
 * @param {string} storyId
 * @param {object} options
 * @param {boolean} options.includeCharacters - Include characters (default: true)
 * @param {boolean} options.includePlaces - Include places (default: true)
 * @param {boolean} options.includeLore - Include lore/world (default: true)
 * @param {boolean} options.includeSystems - Include systems (default: true)
 * @param {boolean} options.includeParameters - Include parameters (default: true)
 * @param {boolean} options.includeArcBoundaries - Include arc boundaries (default: true)
 * @param {boolean} options.includeSummaries - Include summaries (default: true)
 * @param {number} options.maxChars - Max characters per section (default: 2000)
 * @returns {string}
 */
function formatKnowledgeForPrompt(storyId, options = {}) {
  const opts = {
    includeCharacters: true,
    includePlaces: true,
    includeLore: true,
    includeSystems: true,
    includeParameters: true,
    includeArcBoundaries: true,
    includeSummaries: true,
    maxChars: 2000,
    ...options,
  };

  const docs = loadDocs(storyId);
  const parts = [];

  const truncate = (str, max) => {
    if (!str || str.length <= max) return str;
    return str.slice(0, max - 3) + '...';
  };

  // Parameters first (most important for genre adherence)
  if (opts.includeParameters) {
    const params = docs.filter((d) => d.type === 'parameter');
    if (params.length > 0) {
      const paramLines = params.map((p) => {
        let line = `## ${p.title || 'Parameter'}: ${p.content || ''}`;
        if (p.context) line += `\n   Context: ${p.context}`;
        if (p.boundary) line += `\n   Boundary: ${p.boundary}`;
        if (p.bans) line += `\n   Bans: ${p.bans}`;
        return line;
      });
      parts.push('## STORY PARAMETERS (Hard Rules)\n' + truncate(paramLines.join('\n'), opts.maxChars));
    }
  }

  // Arc Boundaries (constraints for current arc)
  if (opts.includeArcBoundaries) {
    const arcs = docs.filter((d) => d.type === 'arc_boundary');
    if (arcs.length > 0) {
      const arcLines = arcs.map((a) => {
        let line = `## ${a.title || 'Arc Boundary'}`;
        if (a.phase) line += ` (${a.phase})`;
        line += `\n   ${a.content || ''}`;
        if (a.constraints) line += `\n   Constraints: ${a.constraints}`;
        if (a.allowedEvents && a.allowedEvents.length) line += `\n   Allowed: ${a.allowedEvents.join(', ')}`;
        if (a.forbiddenEvents && a.forbiddenEvents.length) line += `\n   Forbidden: ${a.forbiddenEvents.join(', ')}`;
        if (a.context) line += `\n   Context: ${a.context}`;
        if (a.boundary) line += `\n   Ends when: ${a.boundary}`;
        return line;
      });
      parts.push('## ARC BOUNDARIES (What Can/Cannot Happen)\n' + truncate(arcLines.join('\n'), opts.maxChars));
    }
  }

  // Systems (magic, tech, etc.)
  if (opts.includeSystems) {
    const systems = docs.filter((d) => d.type === 'system');
    if (systems.length > 0) {
      const sysLines = systems.map((s) => {
        let line = `## ${s.title || 'System'}`;
        if (s.domain) line += ` [${s.domain}]`;
        line += `\n   ${s.content || ''}`;
        if (s.context) line += `\n   Works when: ${s.context}`;
        if (s.boundary) line += `\n   Stops working when: ${s.boundary}`;
        return line;
      });
      parts.push('## SYSTEMS & RULES\n' + truncate(sysLines.join('\n'), opts.maxChars));
    }
  }

  // Characters
  if (opts.includeCharacters) {
    const chars = docs.filter((d) => d.type === 'character');
    if (chars.length > 0) {
      const charLines = chars.map((c) => {
        let line = `## ${c.name || 'Unknown'}`;
        if (c.role) line += ` (${c.role})`;
        line += `\n   ${c.personality || ''}`;
        if (c.backstory) line += `\n   Backstory: ${c.backstory}`;
        if (c.context) line += `\n   Context: ${c.context}`;
        if (c.boundary) line += `\n   Boundary: ${c.boundary}`;
        return line;
      });
      parts.push('## CHARACTERS\n' + truncate(charLines.join('\n'), opts.maxChars));
    }
  }

  // Places
  if (opts.includePlaces) {
    const places = docs.filter((d) => d.type === 'place');
    if (places.length > 0) {
      const placeLines = places.map((p) => {
        let line = `## ${p.title || 'Unknown Place'}`;
        line += `\n   ${p.content || p.description || ''}`;
        if (p.constraints) line += `\n   Constraints: ${p.constraints}`;
        if (p.context) line += `\n   Context: ${p.context}`;
        if (p.boundary) line += `\n   Boundary: ${p.boundary}`;
        return line;
      });
      parts.push('## PLACES\n' + truncate(placeLines.join('\n'), opts.maxChars));
    }
  }

  // Lore/World
  if (opts.includeLore) {
    const lore = docs.filter((d) => d.type === 'lore' || d.type === 'world');
    if (lore.length > 0) {
      const loreLines = lore.map((l) => {
        let line = `## ${l.title || 'Lore'}`;
        line += `\n   ${l.content || ''}`;
        if (l.context) line += `\n   Context: ${l.context}`;
        if (l.boundary) line += `\n   Boundary: ${l.boundary}`;
        return line;
      });
      parts.push('## WORLD LORE\n' + truncate(loreLines.join('\n'), opts.maxChars));
    }
  }

  // Summaries (chronological order)
  if (opts.includeSummaries) {
    const summaries = docs
      .filter((d) => d.type === 'summary')
      .sort((a, b) => (a.chapterNumber || 0) - (b.chapterNumber || 0));
    if (summaries.length > 0) {
      const sumLines = summaries.map((s) => `Ch${s.chapterNumber}: ${s.content || ''}`);
      parts.push('## RECENT CHAPTERS\n' + truncate(sumLines.join('\n'), opts.maxChars));
    }
  }

  return parts.join('\n\n');
}

// ── Reader Experience state (single evolving doc per story) ──────────────────

/**
 * Document id used for the per-story Reader Experience state doc.
 * Stored as type 'reader_experience' so it participates in the existing
 * RAG storage/retrieval mechanisms (no second storage system).
 */
const EXPERIENCE_DOC_ID = 'reader-experience';

/**
 * Load the full Reader Experience state doc for a story (config + evolving
 * state). Returns null when no doc has been created yet.
 *
 * @param {string} storyId
 * @returns {object|null}
 */
function getExperienceState(storyId) {
  _assertValidStoryId(storyId);
  const doc = getDoc(storyId, EXPERIENCE_DOC_ID);
  if (!doc) return null;
  return doc;
}

/**
 * Persist the full Reader Experience state doc (creates or replaces).
 *
 * @param {string} storyId
 * @param {object} state
 */
function saveExperienceState(storyId, state) {
  _assertValidStoryId(storyId);
  const existing = getDoc(storyId, EXPERIENCE_DOC_ID) || {};
  const merged = {
    ...existing,
    ...state,
    id: EXPERIENCE_DOC_ID,
    type: 'reader_experience',
    updatedAt: new Date().toISOString(),
  };
  addDoc(storyId, merged);
  return merged;
}

/**
 * Get the Reader Experience author-intent config for a story.
 * Returns null when the author has not configured Reader Experience yet
 * (which also signals that synthesis/analysis should be skipped — keeping
 * generation backward-compatible for stories that pre-date the feature).
 *
 * @param {string} storyId
 * @returns {object|null}
 */
function getExperienceConfig(storyId) {
  const state = getExperienceState(storyId);
  if (!state || !state.config) return null;
  return state.config;
}

/**
 * Set (or replace) the Reader Experience author-intent config for a story.
 * Preserves any previously-evolved state (currentState, trajectory, etc.).
 *
 * @param {string} storyId
 * @param {object} config
 */
function setExperienceConfig(storyId, config) {
  _assertValidStoryId(storyId);
  const existing = getDoc(storyId, EXPERIENCE_DOC_ID) || {};
  const merged = {
    ...existing,
    id: EXPERIENCE_DOC_ID,
    type: 'reader_experience',
    config,
    updatedAt: new Date().toISOString(),
  };
  addDoc(storyId, merged);
  return merged;
}

// ── Name & Place Localization (single entity_map doc per story) ──────────────

/**
 * Document id used for the per-story Name & Place Localization entity map.
 * Stored as type 'entity_map' so it participates in the existing RAG
 * storage/retrieval mechanisms (no second storage system). The doc holds BOTH
 * the author-intent config (style) and the canonical entity mappings, mirroring
 * the reader_experience single-doc pattern.
 */
const ENTITY_MAP_DOC_ID = 'entity-map';

/**
 * Load the full Name & Place Localization doc for a story (config + entity
 * mappings). Returns null when no doc has been created yet.
 *
 * @param {string} storyId
 * @returns {object|null}
 */
function getEntityMapDoc(storyId) {
  _assertValidStoryId(storyId);
  const doc = getDoc(storyId, ENTITY_MAP_DOC_ID);
  if (!doc) return null;
  return doc;
}

/**
 * Persist the full entity map doc (creates or replaces). Preserves any fields
 * not present in the incoming state (merge semantics, like saveExperienceState).
 *
 * @param {string} storyId
 * @param {object} state - { config?, entities?, ... }
 * @returns {object} The merged doc.
 */
function saveEntityMapDoc(storyId, state) {
  _assertValidStoryId(storyId);
  const existing = getDoc(storyId, ENTITY_MAP_DOC_ID) || {};
  const merged = {
    ...existing,
    ...state,
    id: ENTITY_MAP_DOC_ID,
    type: 'entity_map',
    updatedAt: new Date().toISOString(),
  };
  addDoc(storyId, merged);
  return merged;
}

/**
 * Get the Name & Place Localization author-intent config for a story.
 * Returns null when the author has not enabled localization yet (which signals
 * that canonical-name injection/synthesis should be skipped — keeping
 * generation backward-compatible for stories that pre-date the feature).
 *
 * @param {string} storyId
 * @returns {object|null}
 */
function getLocalizationConfig(storyId) {
  const doc = getEntityMapDoc(storyId);
  if (!doc || !doc.config) return null;
  return doc.config;
}

/**
 * Set (or replace) the Name & Place Localization config for a story.
 * Preserves any previously-assigned entity mappings.
 *
 * @param {string} storyId
 * @param {object} config
 * @returns {object} The merged doc.
 */
function setLocalizationConfig(storyId, config) {
  _assertValidStoryId(storyId);
  const existing = getDoc(storyId, ENTITY_MAP_DOC_ID) || {};
  const merged = {
    ...existing,
    id: ENTITY_MAP_DOC_ID,
    type: 'entity_map',
    config,
    updatedAt: new Date().toISOString(),
  };
  addDoc(storyId, merged);
  return merged;
}

/**
 * Get the canonical entity mappings array for a story. Returns [] when no
 * mappings have been assigned yet (even if a config/style is set).
 *
 * @param {string} storyId
 * @returns {Array<object>}
 */
function getEntityMap(storyId) {
  const doc = getEntityMapDoc(storyId);
  if (!doc || !Array.isArray(doc.entities)) return [];
  return doc.entities;
}

module.exports = {
  addDoc,
  removeDoc,
  listDocs,
  listDocsByType,
  retrieve,
  getDoc,
  upsertKnowledge,
  batchUpsert,
  formatKnowledgeForPrompt,
  clearStory,
  isValidType,
  VALID_TYPES,
  _slugify,
  getExperienceConfig,
  setExperienceConfig,
  getExperienceState,
  saveExperienceState,
  EXPERIENCE_DOC_ID,
  getEntityMapDoc,
  saveEntityMapDoc,
  getLocalizationConfig,
  setLocalizationConfig,
  getEntityMap,
  ENTITY_MAP_DOC_ID,
};

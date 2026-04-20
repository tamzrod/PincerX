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
 * Return the absolute path to the per-story RAG docs file.
 *
 * @param {string} storyId - Already-validated story ID.
 * @returns {string}
 */
function _docsPath(storyId) {
  return path.join(STORIES_DIR, storyId, 'rag-docs.json');
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
  const dir = path.join(STORIES_DIR, storyId);
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
  const dir = path.join(STORIES_DIR, storyId);
  if (!fs.existsSync(dir)) return;
  const p = _docsPath(storyId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  // Remove the directory only when empty.  Only ENOTEMPTY and ENOENT are
  // expected here; any other error is re-thrown.
  try { fs.rmdirSync(dir); } catch (e) {
    if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') throw e;
  }
}

module.exports = { addDoc, removeDoc, listDocs, retrieve, clearStory };

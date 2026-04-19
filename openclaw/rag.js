'use strict';

const fs = require('fs');
const path = require('path');
const ai = require('./ai');

const DOCS_PATH = path.join(__dirname, '..', 'data', 'docs.json');

/**
 * Load all documents from the local JSON store.
 *
 * @returns {Array<{id: string, title: string, content: string}>}
 */
function loadDocs() {
  const raw = fs.readFileSync(DOCS_PATH, 'utf8');
  return JSON.parse(raw);
}

/**
 * Retrieve documents relevant to the query using keyword matching.
 * Scores each document by counting how many query words appear in its content/title.
 *
 * @param {string} query - The user's question.
 * @param {number} [topK=3] - Maximum number of documents to return.
 * @returns {Array<{id: string, title: string, content: string}>}
 */
function retrieve(query, topK = 3) {
  const docs = loadDocs();
  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scored = docs.map((doc) => {
    const haystack = `${doc.title} ${doc.content}`.toLowerCase();
    const score = keywords.reduce((acc, kw) => {
      // Count all occurrences of the keyword
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
 * Build a grounded prompt from retrieved context and the user query,
 * then call the AI layer.
 *
 * @param {string} query - The user's question.
 * @param {object} [aiOptions] - Options forwarded to ai.ask().
 * @returns {Promise<{answer: string, sources: Array<{id: string, title: string}>}>}
 */
async function ask(query, aiOptions = {}) {
  const relevantDocs = retrieve(query);

  if (relevantDocs.length === 0) {
    return {
      answer: 'No relevant information was found in the knowledge base for your query.',
      sources: [],
    };
  }

  const context = relevantDocs
    .map((doc) => `[${doc.title}]\n${doc.content}`)
    .join('\n\n');

  const prompt = [
    'You are a helpful assistant. Answer the question using ONLY the context provided below.',
    'Do not invent information that is not present in the context.',
    '',
    'Context:',
    context,
    '',
    `Question: ${query}`,
    'Answer:',
  ].join('\n');

  const answer = await ai.ask(prompt, aiOptions);

  return {
    answer,
    sources: relevantDocs.map(({ id, title }) => ({ id, title })),
  };
}

module.exports = { ask, retrieve };

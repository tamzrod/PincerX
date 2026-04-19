'use strict';

// Mock ai.js before requiring rag.js so no real HTTP calls are made
jest.mock('../openclaw/ai');

const ai = require('../openclaw/ai');
const rag = require('../openclaw/rag');

afterEach(() => {
  jest.clearAllMocks();
});

describe('OpenClaw rag.js — retrieve()', () => {
  it('returns documents ranked by keyword relevance', () => {
    const results = rag.retrieve('machine learning artificial intelligence');
    expect(results.length).toBeGreaterThan(0);
    // Top result should be the ML doc
    expect(results[0].title).toBe('Introduction to Machine Learning');
  });

  it('returns an empty array when no keywords match', () => {
    const results = rag.retrieve('zzzzxxx nonexistent term');
    expect(results).toEqual([]);
  });

  it('limits results to topK', () => {
    const results = rag.retrieve('the and for is of', 2);
    // All docs contain common words; we only want 2 back
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters out short stop words (≤2 chars)', () => {
    // Single two-character words should match nothing (filter w.length > 2)
    const results = rag.retrieve('is it');
    expect(results).toEqual([]);
  });

  it('returns at most 3 results by default', () => {
    const results = rag.retrieve('data language model api');
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('returns docs containing all required fields', () => {
    const results = rag.retrieve('node javascript');
    results.forEach((doc) => {
      expect(doc).toHaveProperty('id');
      expect(doc).toHaveProperty('title');
      expect(doc).toHaveProperty('content');
    });
  });
});

describe('OpenClaw rag.js — isIntentQuery()', () => {
  it('returns true for "summarize" queries', () => {
    expect(rag.isIntentQuery('Please summarize what you know')).toBe(true);
  });

  it('returns true for "overview" queries', () => {
    expect(rag.isIntentQuery('Give me an overview')).toBe(true);
  });

  it('returns true for "what do you know" queries', () => {
    expect(rag.isIntentQuery('What do you know about this?')).toBe(true);
  });

  it('returns true for "what you know" queries', () => {
    expect(rag.isIntentQuery('Tell me what you know')).toBe(true);
  });

  it('returns false for normal keyword queries', () => {
    expect(rag.isIntentQuery('machine learning artificial intelligence')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(rag.isIntentQuery('SUMMARIZE everything')).toBe(true);
  });
});

describe('OpenClaw rag.js — ask() fallback / intent', () => {
  it('calls ai.ask with fallback docs for a "summarize" intent query', async () => {
    ai.ask.mockResolvedValue('Here is a summary of the knowledge base.');

    const result = await rag.ask('summarize what you know');

    expect(ai.ask).toHaveBeenCalledTimes(1);
    const promptArg = ai.ask.mock.calls[0][0];
    expect(promptArg).toContain('Context:');
    expect(result.answer).toBe('Here is a summary of the knowledge base.');
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('calls ai.ask with fallback docs for an "overview" intent query', async () => {
    ai.ask.mockResolvedValue('Overview of the documents.');

    const result = await rag.ask('give me an overview');

    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('fallback sources contain id and title', async () => {
    ai.ask.mockResolvedValue('Summary here.');

    const result = await rag.ask('summarize what you know');

    result.sources.forEach((s) => {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('title');
    });
  });

  it('does not exceed FALLBACK_CHUNK_COUNT sources in fallback mode', async () => {
    ai.ask.mockResolvedValue('answer');

    const result = await rag.ask('zzzzxxx completely unknown topic');

    expect(result.sources.length).toBeLessThanOrEqual(5);
  });
});

describe('OpenClaw rag.js — ask()', () => {
  it('calls ai.ask with grounded prompt and returns answer + sources', async () => {
    ai.ask.mockResolvedValue('Machine learning lets systems learn from data.');

    // Use keywords that are known to match docs (no special chars stripped)
    const result = await rag.ask('machine learning artificial intelligence');

    expect(ai.ask).toHaveBeenCalledTimes(1);
    const promptArg = ai.ask.mock.calls[0][0];
    // Prompt must include grounding instructions
    expect(promptArg).toContain('ONLY the context provided');
    expect(promptArg).toContain('Do not invent');
    // Prompt must include the retrieved doc content
    expect(promptArg).toContain('Machine Learning');
    // Prompt must end with the user question
    expect(promptArg).toContain('machine learning artificial intelligence');

    expect(result.answer).toBe('Machine learning lets systems learn from data.');
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sources.length).toBeGreaterThan(0);
    result.sources.forEach((s) => {
      expect(s).toHaveProperty('id');
      expect(s).toHaveProperty('title');
    });
  });

  it('calls ai.ask with fallback docs when no docs match the query', async () => {
    ai.ask.mockResolvedValue('Here is what I know based on the available documents.');

    const result = await rag.ask('zzzzxxx completely unknown topic');

    expect(ai.ask).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe('Here is what I know based on the available documents.');
    expect(Array.isArray(result.sources)).toBe(true);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('passes aiOptions through to ai.ask', async () => {
    ai.ask.mockResolvedValue('answer');

    await rag.ask('machine learning', { model: 'mistral', baseUrl: 'http://custom:9000' });

    expect(ai.ask).toHaveBeenCalledWith(
      expect.any(String),
      { model: 'mistral', baseUrl: 'http://custom:9000' }
    );
  });

  it('propagates errors thrown by ai.ask', async () => {
    ai.ask.mockRejectedValue(new Error('AI unavailable'));

    await expect(rag.ask('machine learning')).rejects.toThrow('AI unavailable');
  });
});

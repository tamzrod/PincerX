'use strict';

// Mock OpenClaw modules so integration tests don't call real AI
jest.mock('../openclaw/rag');
jest.mock('../openclaw/feedback');

const request = require('supertest');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');

// Import the app — must happen after jest.mock() calls
let app;
beforeAll(() => {
  app = require('../api/server');
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─── POST /ask ────────────────────────────────────────────────────────────────

describe('POST /ask', () => {
  it('returns 200 with answer and sources on valid query', async () => {
    rag.ask.mockResolvedValue({
      answer: 'Node.js runs on V8.',
      sources: [{ id: '3', title: 'Node.js Overview' }],
    });

    const res = await request(app)
      .post('/ask')
      .send({ query: 'What is Node.js?' });

    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Node.js runs on V8.');
    expect(res.body.sources).toEqual([{ id: '3', title: 'Node.js Overview' }]);
    expect(rag.ask).toHaveBeenCalledWith('What is Node.js?');
  });

  it('trims whitespace from query before passing to rag', async () => {
    rag.ask.mockResolvedValue({ answer: 'ok', sources: [] });

    await request(app)
      .post('/ask')
      .send({ query: '  machine learning  ' });

    expect(rag.ask).toHaveBeenCalledWith('machine learning');
  });

  it('returns 400 when query is missing', async () => {
    const res = await request(app).post('/ask').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it('returns 400 when query is an empty string', async () => {
    const res = await request(app).post('/ask').send({ query: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it('returns 400 when query is a blank string', async () => {
    const res = await request(app).post('/ask').send({ query: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it('returns 400 when query is not a string', async () => {
    const res = await request(app).post('/ask').send({ query: 123 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query/i);
  });

  it('returns 502 when OpenClaw rag throws an error', async () => {
    rag.ask.mockRejectedValue(new Error('AI unavailable'));

    const res = await request(app).post('/ask').send({ query: 'What is AI?' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/OpenClaw RAG error/);
    expect(res.body.error).toMatch(/AI unavailable/);
  });
});

// ─── POST /analyze ────────────────────────────────────────────────────────────

describe('POST /analyze', () => {
  it('returns 200 with structured feedback on valid text', async () => {
    feedback.analyze.mockResolvedValue({
      sentiment: 'positive',
      topic: 'Product Quality',
      suggestions: ['Keep it up'],
    });

    const res = await request(app)
      .post('/analyze')
      .send({ text: 'This is a great product.' });

    expect(res.status).toBe(200);
    expect(res.body.sentiment).toBe('positive');
    expect(res.body.topic).toBe('Product Quality');
    expect(res.body.suggestions).toEqual(['Keep it up']);
    expect(feedback.analyze).toHaveBeenCalledWith('This is a great product.');
  });

  it('trims whitespace from text before passing to feedback', async () => {
    feedback.analyze.mockResolvedValue({
      sentiment: 'neutral',
      topic: 'Test',
      suggestions: [],
    });

    await request(app)
      .post('/analyze')
      .send({ text: '  trimmed text  ' });

    expect(feedback.analyze).toHaveBeenCalledWith('trimmed text');
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app).post('/analyze').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 400 when text is an empty string', async () => {
    const res = await request(app).post('/analyze').send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 400 when text is a blank string', async () => {
    const res = await request(app).post('/analyze').send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 400 when text is not a string', async () => {
    const res = await request(app).post('/analyze').send({ text: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 502 when OpenClaw feedback throws an error', async () => {
    feedback.analyze.mockRejectedValue(new Error('parse failure'));

    const res = await request(app).post('/analyze').send({ text: 'some text' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/OpenClaw Feedback error/);
    expect(res.body.error).toMatch(/parse failure/);
  });
});

'use strict';

// Mock OpenClaw modules so integration tests don't call real AI
jest.mock('../openclaw/rag');
jest.mock('../openclaw/feedback');
jest.mock('../ingest');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');
const { ingest } = require('../ingest');

// Import the app — must happen after jest.mock() calls
let app;
beforeAll(() => {
  app = require('../api/server');
});

afterEach(() => {
  jest.clearAllMocks();
});

// ─── GET /config + POST /config ───────────────────────────────────────────────

describe('GET /config', () => {
  const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');

  afterEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  });

  it('returns defaults when no config file exists', async () => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('baseUrl');
    expect(res.body).toHaveProperty('model');
    expect(res.body).toHaveProperty('hasApiKey');
  });

  it('returns stored config values when file exists', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: 'http://10.0.0.1:11434', model: 'llama3.2', apiKey: 'secret' }), 'utf8');
    const res = await request(app).get('/config');
    expect(res.status).toBe(200);
    expect(res.body.baseUrl).toBe('http://10.0.0.1:11434');
    expect(res.body.model).toBe('llama3.2');
    expect(res.body.hasApiKey).toBe(true);
  });

  it('does not expose the raw apiKey value in the response', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: 'supersecret' }), 'utf8');
    const res = await request(app).get('/config');
    expect(res.body.apiKey).toBeUndefined();
  });
});

describe('POST /config', () => {
  const CONFIG_PATH = path.join(__dirname, '..', 'data', 'ai-config.json');

  afterEach(() => {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
  });

  it('saves config and returns success message', async () => {
    const res = await request(app)
      .post('/config')
      .send({ baseUrl: 'http://192.168.1.10:11434', model: 'llama3.2', apiKey: '' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/saved/i);
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(stored.baseUrl).toBe('http://192.168.1.10:11434');
    expect(stored.model).toBe('llama3.2');
  });

  it('returns 400 when baseUrl is missing', async () => {
    const res = await request(app).post('/config').send({ model: 'llama3' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/baseUrl/i);
  });

  it('returns 400 when baseUrl is an empty string', async () => {
    const res = await request(app).post('/config').send({ baseUrl: '', model: 'llama3' });
    expect(res.status).toBe(400);
  });

  it('returns 400 when baseUrl is not a valid URL', async () => {
    const res = await request(app).post('/config').send({ baseUrl: 'not-a-url', model: 'llama3' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid URL/i);
  });

  it('preserves existing apiKey when apiKey is not included in the request', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: 'existing-key' }), 'utf8');
    const res = await request(app).post('/config').send({ baseUrl: 'http://localhost:11434', model: 'llama3.2' });
    expect(res.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(stored.apiKey).toBe('existing-key');
  });

  it('clears the apiKey when an empty string is sent', async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: 'existing-key' }), 'utf8');
    const res = await request(app).post('/config').send({ baseUrl: 'http://localhost:11434', model: 'llama3', apiKey: '' });
    expect(res.status).toBe(200);
    const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    expect(stored.apiKey).toBe('');
  });
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

// ─── POST /upload ─────────────────────────────────────────────────────────────

describe('POST /upload', () => {
  const PDF_DIR = path.join(__dirname, '..', 'pdfs');
  const testPdf = path.join(PDF_DIR, 'test-upload.pdf');

  beforeAll(() => {
    fs.mkdirSync(PDF_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testPdf)) fs.unlinkSync(testPdf);
    const testTxt = path.join(PDF_DIR, 'notes.txt');
    if (fs.existsSync(testTxt)) fs.unlinkSync(testTxt);
  });

  it('returns 200 and triggers ingest when a valid PDF is uploaded', async () => {
    ingest.mockResolvedValue();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'test-upload.pdf');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/test-upload\.pdf/);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('returns 200 and triggers ingest when a .txt file is uploaded', async () => {
    ingest.mockResolvedValue();

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('hello world'), 'notes.txt');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/notes\.txt/);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app).post('/upload').send();
    expect(res.status).toBe(400);
  });

  it('returns 400 when uploaded file type is not supported', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('data'), 'file.xyz');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported file type/i);
  });

  it('returns 500 when ingestion fails', async () => {
    ingest.mockRejectedValue(new Error('ingest error'));

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'test-upload.pdf');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ingest error/);
  });

  it('returns 409 when ingestion is already in progress', async () => {
    const err = new Error('Ingestion is already in progress.');
    err.code = 'INGESTION_IN_PROGRESS';
    ingest.mockRejectedValue(err);

    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), 'test-upload.pdf');

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
  });
});

// ─── DELETE /pdf ──────────────────────────────────────────────────────────────

describe('DELETE /pdf', () => {
  const PDF_DIR = path.join(__dirname, '..', 'pdfs');
  const testFilename = 'delete-me.pdf';
  const testPdf = path.join(PDF_DIR, testFilename);

  beforeAll(() => {
    fs.mkdirSync(PDF_DIR, { recursive: true });
  });

  it('returns 200 and triggers ingest when a valid PDF is deleted', async () => {
    fs.writeFileSync(testPdf, '%PDF-1.4 fake');
    ingest.mockResolvedValue();

    const res = await request(app)
      .delete('/pdf')
      .send({ filename: testFilename });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/delete-me\.pdf/);
    expect(fs.existsSync(testPdf)).toBe(false);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the file does not exist', async () => {
    const res = await request(app)
      .delete('/pdf')
      .send({ filename: 'nonexistent.pdf' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when filename is missing', async () => {
    const res = await request(app).delete('/pdf').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/filename/i);
  });

  it('returns 400 when filename has an unsupported extension', async () => {
    const res = await request(app)
      .delete('/pdf')
      .send({ filename: 'secret.xyz' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/supported extension/i);
  });

  it('returns 400 when filename contains path traversal', async () => {
    const res = await request(app)
      .delete('/pdf')
      .send({ filename: '../secret.pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('returns 500 when ingestion fails', async () => {
    fs.writeFileSync(testPdf, '%PDF-1.4 fake');
    ingest.mockRejectedValue(new Error('ingest boom'));

    const res = await request(app)
      .delete('/pdf')
      .send({ filename: testFilename });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ingest boom/);
  });

  it('returns 409 when ingestion is already in progress', async () => {
    fs.writeFileSync(testPdf, '%PDF-1.4 fake');
    const err = new Error('Ingestion is already in progress.');
    err.code = 'INGESTION_IN_PROGRESS';
    ingest.mockRejectedValue(err);

    const res = await request(app)
      .delete('/pdf')
      .send({ filename: testFilename });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/i);
  });
});

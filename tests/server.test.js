'use strict';

// Mock OpenClaw modules so integration tests don't call real AI
jest.mock('../openclaw/rag');
jest.mock('../openclaw/feedback');
jest.mock('../ingest');
jest.mock('../story/story');

const request = require('supertest');
const path = require('path');
const fs = require('fs');
const rag = require('../openclaw/rag');
const feedback = require('../openclaw/feedback');
const { ingest } = require('../ingest');
const story = require('../story/story');

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

  it('returns 400 when no file is provided', async () => {
    const res = await request(app).post('/upload').send();
    expect(res.status).toBe(400);
  });

  it('returns 400 when uploaded file is not a PDF', async () => {
    const res = await request(app)
      .post('/upload')
      .attach('file', Buffer.from('hello'), 'test.txt');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF/i);
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

  it('returns 400 when filename is not a PDF', async () => {
    const res = await request(app)
      .delete('/pdf')
      .send({ filename: 'secret.txt' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/\.pdf/i);
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

// ─── POST /story/:id/chapter ──────────────────────────────────────────────────

describe('POST /story/:id/chapter', () => {
  it('returns 201 with chapter content on valid input', async () => {
    story.generateChapter.mockResolvedValue({
      storyId: '1234-my-story',
      chapterNumber: 1,
      content: 'The sun rose over the hills as our hero stepped outside.',
    });

    const res = await request(app)
      .post('/story/1234-my-story/chapter')
      .send({ chapterNumber: 1 });

    expect(res.status).toBe(201);
    expect(res.body.storyId).toBe('1234-my-story');
    expect(res.body.chapterNumber).toBe(1);
    expect(res.body.content).toMatch(/sun rose/);
    expect(story.generateChapter).toHaveBeenCalledWith('1234-my-story', 1, {}, '');
  });

  it('returns 400 when story ID contains invalid characters', async () => {
    const res = await request(app)
      .post('/story/my.story_id/chapter')
      .send({ chapterNumber: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid story id/i);
  });

  it('returns 400 when story ID is uppercase', async () => {
    const res = await request(app)
      .post('/story/UPPERCASE-ID/chapter')
      .send({ chapterNumber: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid story id/i);
  });

  it('returns 400 when chapterNumber is missing', async () => {
    const res = await request(app)
      .post('/story/1234-my-story/chapter')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chapterNumber/i);
  });

  it('returns 400 when chapterNumber is zero', async () => {
    const res = await request(app)
      .post('/story/1234-my-story/chapter')
      .send({ chapterNumber: 0 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chapterNumber/i);
  });

  it('returns 400 when chapterNumber is a float', async () => {
    const res = await request(app)
      .post('/story/1234-my-story/chapter')
      .send({ chapterNumber: 1.5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/chapterNumber/i);
  });

  it('returns 404 when the story does not exist', async () => {
    story.generateChapter.mockRejectedValue(new Error('Story not found: missing-story'));

    const res = await request(app)
      .post('/story/missing-story/chapter')
      .send({ chapterNumber: 1 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/story not found/i);
  });

  it('returns 502 when AI generation fails', async () => {
    story.generateChapter.mockRejectedValue(new Error('AI offline'));

    const res = await request(app)
      .post('/story/1234-my-story/chapter')
      .send({ chapterNumber: 2 });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Chapter generation error/);
    expect(res.body.error).toMatch(/AI offline/);
  });
});


describe('POST /story/create', () => {
  it('returns 201 with the created story on valid input', async () => {
    story.create.mockResolvedValue({
      id: '1234-brave-new-world',
      title: 'Brave New World',
      genre: 'dystopia',
      tone: 'dark',
      outline: 'Act 1: Utopia. Act 2: Cracks. Act 3: Collapse.',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await request(app)
      .post('/story/create')
      .send({ title: 'Brave New World', genre: 'dystopia', tone: 'dark' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Brave New World');
    expect(res.body.genre).toBe('dystopia');
    expect(res.body.tone).toBe('dark');
    expect(res.body.outline).toMatch(/Utopia/);
    expect(story.create).toHaveBeenCalledWith('Brave New World', 'dystopia', 'dark');
  });

  it('trims whitespace from title, genre, and tone before passing to story.create', async () => {
    story.create.mockResolvedValue({
      id: 'x',
      title: 'Trimmed',
      genre: 'fantasy',
      tone: 'epic',
      outline: 'outline',
      createdAt: '2026-01-01T00:00:00.000Z',
    });

    await request(app)
      .post('/story/create')
      .send({ title: '  Trimmed  ', genre: '  fantasy  ', tone: '  epic  ' });

    expect(story.create).toHaveBeenCalledWith('Trimmed', 'fantasy', 'epic');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(app)
      .post('/story/create')
      .send({ genre: 'fantasy', tone: 'epic' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('returns 400 when genre is missing', async () => {
    const res = await request(app)
      .post('/story/create')
      .send({ title: 'My Story', tone: 'epic' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/genre/i);
  });

  it('returns 400 when tone is missing', async () => {
    const res = await request(app)
      .post('/story/create')
      .send({ title: 'My Story', genre: 'fantasy' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tone/i);
  });

  it('returns 400 when title is an empty string', async () => {
    const res = await request(app)
      .post('/story/create')
      .send({ title: '', genre: 'fantasy', tone: 'epic' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title/i);
  });

  it('returns 400 when genre is not a string', async () => {
    const res = await request(app)
      .post('/story/create')
      .send({ title: 'My Story', genre: 42, tone: 'epic' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/genre/i);
  });

  it('returns 502 when story.create throws an error', async () => {
    story.create.mockRejectedValue(new Error('AI offline'));

    const res = await request(app)
      .post('/story/create')
      .send({ title: 'My Story', genre: 'fantasy', tone: 'epic' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Story generation error/);
    expect(res.body.error).toMatch(/AI offline/);
  });
});

// ─── POST /tts ───────────────────────────────────────────────────────────────

const TTS_CACHE_DIR = path.join(__dirname, '..', 'data', 'tts-cache');

function clearTtsCache() {
  if (fs.existsSync(TTS_CACHE_DIR)) {
    for (const f of fs.readdirSync(TTS_CACHE_DIR).filter((n) => n.endsWith('.wav'))) {
      fs.unlinkSync(path.join(TTS_CACHE_DIR, f));
    }
  }
}

describe('POST /tts', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    clearTtsCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    clearTtsCache();
  });

  it('returns 400 when text is missing', async () => {
    const res = await request(app).post('/tts').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 400 when text is an empty string', async () => {
    const res = await request(app).post('/tts').send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns 400 when text is a blank string', async () => {
    const res = await request(app).post('/tts').send({ text: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it('returns audio/wav with 200 when Zonos responds successfully', async () => {
    const fakeWav = Buffer.from('RIFF');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    const res = await request(app).post('/tts').send({ text: 'Hello world' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/synthesize'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the text to Zonos trimmed and capped at 50 000 characters', async () => {
    const fakeWav = Buffer.from('RIFF');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    const longText = 'a'.repeat(60_000);
    await request(app).post('/tts').send({ text: `  ${longText}  ` });

    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.text.length).toBeLessThanOrEqual(50_000);
  });

  it('forwards voice_id, speaking_rate, pitch_std, emotion_preset to Zonos', async () => {
    const fakeWav = Buffer.from('RIFF');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    await request(app).post('/tts').send({
      text: 'Hello world',
      voice_id: 'myVoice',
      speaking_rate: 12.5,
      pitch_std: 60,
      emotion_preset: 'calm',
    });

    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody.voice_id).toBe('myVoice');
    expect(sentBody.speaking_rate).toBe(12.5);
    expect(sentBody.pitch_std).toBe(60);
    expect(sentBody.emotion_preset).toBe('calm');
  });

  it('omits voice_id from the Zonos request when not provided', async () => {
    const fakeWav = Buffer.from('RIFF');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    await request(app).post('/tts').send({ text: 'Hello world' });

    const sentBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(sentBody).not.toHaveProperty('voice_id');
  });

  it('returns 502 with error message when Zonos returns a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('model crashed'),
    });

    const res = await request(app).post('/tts').send({ text: 'Hello world' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service error/i);
    expect(res.body.error).toMatch(/model crashed/);
  });

  it('returns 502 when the Zonos sidecar is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).post('/tts').send({ text: 'Hello world' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service unreachable/i);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });

  it('saves audio to the cache after the first synthesis', async () => {
    const fakeWav = Buffer.from('RIFF-fake-wav');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    await request(app).post('/tts').send({ text: 'Cache me please' });

    const files = fs.existsSync(TTS_CACHE_DIR) ? fs.readdirSync(TTS_CACHE_DIR).filter((f) => f.endsWith('.wav')) : [];
    expect(files.length).toBe(1);
  });

  it('serves audio from the cache on a repeat request without calling Zonos', async () => {
    const fakeWav = Buffer.from('RIFF-cached');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    // First request – synthesizes and caches.
    await request(app).post('/tts').send({ text: 'Cached text' });
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Second request with identical params – must be served from cache.
    const res = await request(app).post('/tts').send({ text: 'Cached text' });
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1); // Zonos not called again
    expect(res.headers['x-tts-cache']).toBe('hit');
  });

  it('uses a separate cache entry for different voice settings', async () => {
    const fakeWav = Buffer.from('RIFF');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeWav.buffer),
    });

    await request(app).post('/tts').send({ text: 'Same text', speaking_rate: 12 });
    await request(app).post('/tts').send({ text: 'Same text', speaking_rate: 20 });

    // Two different cache keys → Zonos called twice.
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const files = fs.existsSync(TTS_CACHE_DIR) ? fs.readdirSync(TTS_CACHE_DIR).filter((f) => f.endsWith('.wav')) : [];
    expect(files.length).toBe(2);
  });
});

// ─── DELETE /tts/cache ───────────────────────────────────────────────────────

describe('DELETE /tts/cache', () => {
  beforeEach(() => { clearTtsCache(); });
  afterEach(() => { clearTtsCache(); });

  it('returns 200 with count 0 when the cache is already empty', async () => {
    const res = await request(app).delete('/tts/cache');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.message).toMatch(/0/);
  });

  it('removes all cached WAV files and reports the count', async () => {
    // Manually plant two fake cache files.
    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(TTS_CACHE_DIR, 'aaa.wav'), 'fake');
    fs.writeFileSync(path.join(TTS_CACHE_DIR, 'bbb.wav'), 'fake');

    const res = await request(app).delete('/tts/cache');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    const remaining = fs.readdirSync(TTS_CACHE_DIR).filter((f) => f.endsWith('.wav'));
    expect(remaining.length).toBe(0);
  });
});

// ─── GET /tts/voices ─────────────────────────────────────────────────────────

describe('GET /tts/voices', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns voices and emotion_presets from Zonos', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ voices: ['alice', 'bob'], emotion_presets: ['neutral', 'happy'] }),
    });

    const res = await request(app).get('/tts/voices');

    expect(res.status).toBe(200);
    expect(res.body.voices).toEqual(['alice', 'bob']);
    expect(res.body.emotion_presets).toEqual(['neutral', 'happy']);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/voices'),
      expect.any(Object),
    );
  });

  it('returns 502 when Zonos is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).get('/tts/voices');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service unreachable/i);
  });
});

// ─── POST /tts/voice ─────────────────────────────────────────────────────────

describe('POST /tts/voice', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app).post('/tts/voice').field('name', 'myVoice');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/audio file/i);
  });

  it('returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/tts/voice')
      .attach('file', Buffer.from('audio data'), { filename: 'clip.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid.*name/i);
  });

  it('returns 400 when name contains invalid characters', async () => {
    const res = await request(app)
      .post('/tts/voice')
      .field('name', 'bad name!')
      .attach('file', Buffer.from('audio data'), { filename: 'clip.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid.*name/i);
  });

  it('forwards the upload to Zonos and returns the response on success', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ message: "Voice 'myVoice' saved.", voice_id: 'myVoice' }),
    });

    const res = await request(app)
      .post('/tts/voice')
      .field('name', 'myVoice')
      .attach('file', Buffer.from('audio data'), { filename: 'clip.wav', contentType: 'audio/wav' });

    expect(res.status).toBe(200);
    expect(res.body.voice_id).toBe('myVoice');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/voices/upload?name=myVoice'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('returns 502 with error message when Zonos returns a non-OK status', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('embedding failed'),
    });

    const res = await request(app)
      .post('/tts/voice')
      .field('name', 'myVoice')
      .attach('file', Buffer.from('audio data'), { filename: 'clip.wav', contentType: 'audio/wav' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service error/i);
    expect(res.body.error).toMatch(/embedding failed/);
  });

  it('returns 502 when the Zonos sidecar is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app)
      .post('/tts/voice')
      .field('name', 'myVoice')
      .attach('file', Buffer.from('audio data'), { filename: 'clip.wav', contentType: 'audio/wav' });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service unreachable/i);
    expect(res.body.error).toMatch(/ECONNREFUSED/);
  });
});

// ─── DELETE /tts/voice/:id ───────────────────────────────────────────────────

describe('DELETE /tts/voice/:id', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('returns 400 for invalid voice ID characters', async () => {
    const res = await request(app).delete('/tts/voice/bad%20name');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid voice id/i);
  });

  it('forwards DELETE to Zonos and returns the response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ message: "Voice 'alice' deleted." }),
    });

    const res = await request(app).delete('/tts/voice/alice');

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/alice/);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/voices/alice'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns 404 when Zonos reports voice not found', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Voice not found'),
      json: () => Promise.resolve({ detail: 'Voice not found' }),
    });

    const res = await request(app).delete('/tts/voice/nonexistent');

    expect(res.status).toBe(404);
  });

  it('returns 502 when Zonos is unreachable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const res = await request(app).delete('/tts/voice/alice');

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/TTS service unreachable/i);
  });
});

// ─── GET /story/list ──────────────────────────────────────────────────────────

describe('GET /story/list', () => {
  it('returns an empty stories array when story.list returns []', async () => {
    story.list = jest.fn().mockReturnValue([]);
    const res = await request(app).get('/story/list');
    expect(res.status).toBe(200);
    expect(res.body.stories).toEqual([]);
  });

  it('returns stories from story.list', async () => {
    const fakeStory = { id: '123-test', title: 'Test', genre: 'fantasy', tone: 'dark', createdAt: new Date().toISOString(), chapterCount: 2 };
    story.list = jest.fn().mockReturnValue([fakeStory]);
    const res = await request(app).get('/story/list');
    expect(res.status).toBe(200);
    expect(res.body.stories).toHaveLength(1);
    expect(res.body.stories[0].id).toBe('123-test');
  });

  it('returns 500 when story.list throws', async () => {
    story.list = jest.fn().mockImplementation(() => { throw new Error('disk error'); });
    const res = await request(app).get('/story/list');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/Failed to list stories/i);
  });
});

// ─── GET /story/:id ───────────────────────────────────────────────────────────

describe('GET /story/:id', () => {
  it('returns 400 for an invalid story ID', async () => {
    const res = await request(app).get('/story/INVALID_ID!');
    expect(res.status).toBe(400);
  });

  it('returns the full story when story.get succeeds', async () => {
    const fakeStory = { id: '123-test', title: 'Test', chapters: [] };
    story.get = jest.fn().mockReturnValue(fakeStory);
    const res = await request(app).get('/story/123-test');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('123-test');
    expect(story.get).toHaveBeenCalledWith('123-test');
  });

  it('returns 404 when story.get throws "Story not found"', async () => {
    story.get = jest.fn().mockImplementation(() => { throw new Error('Story not found: 123-test'); });
    const res = await request(app).get('/story/123-test');
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /story/:id ────────────────────────────────────────────────────────

describe('DELETE /story/:id', () => {
  it('returns 400 for an invalid story ID', async () => {
    const res = await request(app).delete('/story/INVALID!!');
    expect(res.status).toBe(400);
  });

  it('deletes the story and returns the story ID', async () => {
    story.deleteStory = jest.fn().mockReturnValue({ storyId: 'abc-test' });
    const res = await request(app).delete('/story/abc-test');
    expect(res.status).toBe(200);
    expect(res.body.storyId).toBe('abc-test');
    expect(story.deleteStory).toHaveBeenCalledWith('abc-test');
  });

  it('returns 404 when the story does not exist', async () => {
    story.deleteStory = jest.fn().mockImplementation(() => { throw new Error('Story not found: abc-test'); });
    const res = await request(app).delete('/story/abc-test');
    expect(res.status).toBe(404);
  });
});

// ─── POST /story/:id/chapter/:num/tts-prebake ────────────────────────────────

describe('POST /story/:id/chapter/:num/tts-prebake', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; clearTtsCache(); });
  afterEach(() => { global.fetch = originalFetch; clearTtsCache(); });

  it('returns 400 for an invalid story ID', async () => {
    const res = await request(app).post('/story/BAD_ID/chapter/1/tts-prebake').send({});
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-integer chapter number', async () => {
    story.get = jest.fn().mockReturnValue({ id: 'abc-test', chapters: [] });
    const res = await request(app).post('/story/abc-test/chapter/0/tts-prebake').send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 when story.get throws Story not found', async () => {
    story.get = jest.fn().mockImplementation(() => { throw new Error('Story not found: abc-test'); });
    const res = await request(app).post('/story/abc-test/chapter/1/tts-prebake').send({});
    expect(res.status).toBe(404);
  });

  it('returns 404 when chapter does not exist in story', async () => {
    story.get = jest.fn().mockReturnValue({ id: 'abc-test', chapters: [{ number: 2, content: 'text' }] });
    const res = await request(app).post('/story/abc-test/chapter/1/tts-prebake').send({});
    expect(res.status).toBe(404);
  });

  it('returns jobId and total immediately without waiting for synthesis', async () => {
    story.get = jest.fn().mockReturnValue({
      id: 'abc-test',
      chapters: [{ number: 1, content: 'Hello world. This is a chapter.' }],
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(Buffer.from('RIFF').buffer),
    });

    const res = await request(app)
      .post('/story/abc-test/chapter/1/tts-prebake')
      .send({ speaking_rate: 15, pitch_std: 45, emotion_preset: 'neutral' });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('jobId');
    expect(res.body).toHaveProperty('total');
    expect(typeof res.body.jobId).toBe('string');
    expect(typeof res.body.total).toBe('number');
  });
});

// ─── GET /tts-prebake/:jobId ──────────────────────────────────────────────────

describe('GET /tts-prebake/:jobId', () => {
  it('returns a synthetic complete status for an unknown job ID', async () => {
    const res = await request(app).get('/tts-prebake/nonexistent-job-id');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('complete');
  });
});

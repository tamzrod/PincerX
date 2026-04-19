'use strict';

// Mock ai.js so no real HTTP calls are made
jest.mock('../openclaw/ai');

const ai = require('../openclaw/ai');
const feedback = require('../openclaw/feedback');

afterEach(() => {
  jest.clearAllMocks();
});

describe('OpenClaw feedback.js — analyze()', () => {
  it('returns structured JSON for a positive sentiment response', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'positive',
      topic: 'Product Quality',
      suggestions: ['Keep up the good work', 'Add more examples'],
    }));

    const result = await feedback.analyze('This product is excellent!');

    expect(result).toEqual({
      sentiment: 'positive',
      topic: 'Product Quality',
      suggestions: ['Keep up the good work', 'Add more examples'],
    });
  });

  it('returns structured JSON for a negative sentiment response', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'negative',
      topic: 'Customer Service',
      suggestions: ['Improve response time'],
    }));

    const result = await feedback.analyze('The service was terrible.');

    expect(result.sentiment).toBe('negative');
    expect(result.topic).toBe('Customer Service');
    expect(result.suggestions).toContain('Improve response time');
  });

  it('returns neutral when sentiment value is unrecognised', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'mixed',
      topic: 'Random',
      suggestions: ['Do something'],
    }));

    const result = await feedback.analyze('Some ambiguous text.');
    expect(result.sentiment).toBe('neutral');
  });

  it('normalizes sentiment to lowercase', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'POSITIVE',
      topic: 'Test',
      suggestions: ['ok'],
    }));

    const result = await feedback.analyze('Great!');
    expect(result.sentiment).toBe('positive');
  });

  it('uses fallback suggestions when AI returns non-array suggestions', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'neutral',
      topic: 'Test',
      suggestions: 'single string not array',
    }));

    const result = await feedback.analyze('some text');
    expect(Array.isArray(result.suggestions)).toBe(true);
    expect(result.suggestions[0]).toBe('No suggestions available.');
  });

  it('returns fallback when AI response contains no JSON object', async () => {
    ai.ask.mockResolvedValue('Sorry, I cannot help with that.');

    const result = await feedback.analyze('some text');
    expect(result.sentiment).toBe('neutral');
    expect(result.topic).toBe('Unknown');
    expect(result.suggestions[0]).toMatch(/Could not extract JSON/);
  });

  it('returns fallback when JSON is malformed', async () => {
    ai.ask.mockResolvedValue('{broken json here,,,}');

    const result = await feedback.analyze('some text');
    expect(result.sentiment).toBe('neutral');
    expect(result.topic).toBe('Unknown');
    expect(result.suggestions[0]).toMatch(/Failed to parse/);
  });

  it('handles topic that is not a string by defaulting to Unknown', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'neutral',
      topic: 42,
      suggestions: ['ok'],
    }));

    const result = await feedback.analyze('text');
    expect(result.topic).toBe('Unknown');
  });

  it('passes aiOptions through to ai.ask', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'neutral',
      topic: 'Test',
      suggestions: ['ok'],
    }));

    await feedback.analyze('text', { model: 'mistral' });

    expect(ai.ask).toHaveBeenCalledWith(
      expect.any(String),
      { model: 'mistral' }
    );
  });

  it('builds a prompt that asks for strict JSON with required fields', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      sentiment: 'positive',
      topic: 'Testing',
      suggestions: ['good'],
    }));

    await feedback.analyze('Some text to analyze.');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('sentiment');
    expect(prompt).toContain('topic');
    expect(prompt).toContain('suggestions');
    expect(prompt).toContain('Some text to analyze.');
  });

  it('propagates errors thrown by ai.ask', async () => {
    ai.ask.mockRejectedValue(new Error('AI unavailable'));
    await expect(feedback.analyze('text')).rejects.toThrow('AI unavailable');
  });
});

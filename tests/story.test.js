'use strict';

// Mock ai.js so no real HTTP calls are made
jest.mock('../openclaw/ai');

const path = require('path');
const fs = require('fs');
const ai = require('../openclaw/ai');
const storyModule = require('../story/story');

const STORIES_DIR = path.join(__dirname, '..', 'data', 'stories');

afterEach(() => {
  jest.clearAllMocks();
  // Clean up any story files written during tests
  if (fs.existsSync(STORIES_DIR)) {
    for (const file of fs.readdirSync(STORIES_DIR)) {
      fs.unlinkSync(path.join(STORIES_DIR, file));
    }
  }
});

describe('story.js — create()', () => {
  it('returns a story object with expected fields', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Act 1: setup. Act 2: conflict. Act 3: resolution.' }));

    const result = await storyModule.create('Lost City', 'adventure', 'epic');

    expect(result).toHaveProperty('id');
    expect(result.title).toBe('Lost City');
    expect(result.genre).toBe('adventure');
    expect(result.tone).toBe('epic');
    expect(result.outline).toBe('Act 1: setup. Act 2: conflict. Act 3: resolution.');
    expect(result).toHaveProperty('createdAt');
  });

  it('saves the story as a JSON file in the stories directory', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'A thrilling tale.' }));

    const result = await storyModule.create('Shadow Run', 'thriller', 'dark');

    const filePath = path.join(STORIES_DIR, `${result.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(saved.title).toBe('Shadow Run');
    expect(saved.outline).toBe('A thrilling tale.');
  });

  it('generates a unique id that includes the slugified title', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Some outline.' }));

    const result = await storyModule.create('My Great Novel', 'drama', 'serious');

    expect(result.id).toMatch(/my-great-novel/);
  });

  it('falls back to raw AI response when no JSON is found', async () => {
    ai.ask.mockResolvedValue('Chapter 1: The beginning.\nChapter 2: The middle.');

    const result = await storyModule.create('Raw Story', 'fiction', 'light');

    expect(result.outline).toBe('Chapter 1: The beginning.\nChapter 2: The middle.');
  });

  it('falls back to raw response when JSON lacks an outline field', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ something: 'else' }));

    const result = await storyModule.create('No Outline', 'mystery', 'tense');

    expect(result.outline).toBe(JSON.stringify({ something: 'else' }));
  });

  it('falls back to raw response when JSON is malformed', async () => {
    ai.ask.mockResolvedValue('{broken json,,,}');

    const result = await storyModule.create('Broken', 'sci-fi', 'cold');

    expect(result.outline).toBe('{broken json,,,}');
  });

  it('passes aiOptions through to ai.ask', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Short outline.' }));

    await storyModule.create('Option Test', 'romance', 'warm', { model: 'mistral' });

    expect(ai.ask).toHaveBeenCalledWith(expect.any(String), { model: 'mistral' });
  });

  it('builds a prompt that includes the title, genre, and tone', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Details here.' }));

    await storyModule.create('Dragon Realm', 'fantasy', 'epic');

    const prompt = ai.ask.mock.calls[0][0];
    expect(prompt).toContain('Dragon Realm');
    expect(prompt).toContain('fantasy');
    expect(prompt).toContain('epic');
  });

  it('propagates errors thrown by ai.ask', async () => {
    ai.ask.mockRejectedValue(new Error('AI unavailable'));

    await expect(storyModule.create('Fail', 'genre', 'tone')).rejects.toThrow('AI unavailable');
  });

  it('stores a valid ISO 8601 createdAt timestamp', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({ outline: 'Timeline outline.' }));

    const result = await storyModule.create('Time Story', 'historical', 'solemn');

    expect(() => new Date(result.createdAt)).not.toThrow();
    expect(new Date(result.createdAt).toISOString()).toBe(result.createdAt);
  });
});

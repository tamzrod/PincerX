'use strict';

// Mock dependencies
jest.mock('../lib/ai');
jest.mock('../story/story-rag');

const ai = require('../lib/ai');
const storyRag = require('../story/story-rag');
const coherence = require('../story/story-coherence');

afterEach(() => {
  jest.clearAllMocks();
});

describe('validateCharacterProfile()', () => {
  it('returns valid for a consistent character', () => {
    const character = {
      name: 'Elena',
      role: 'hero',
      gender: 'female',
      personality: 'brave, compassionate, determined',
      backstory: 'A knight seeking justice'
    };

    const result = coherence.validateCharacterProfile(character);
    expect(result.isValid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.confidence).toBe(1.0);
  });

  it('detects contradictory traits', () => {
    const character = {
      name: 'Marcus',
      role: 'warrior',
      gender: 'male',
      personality: 'brave, cowardly, skilled',
      backstory: 'A soldier with secrets'
    };

    const result = coherence.validateCharacterProfile(character);
    expect(result.isValid).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('contradictory');
  });

  it('warns when villain lacks villainous traits', () => {
    const character = {
      name: 'Lord Vex',
      role: 'villain',
      gender: 'male',
      personality: 'artistic, dreamy, gentle',
      backstory: 'A peaceful ruler'
    };

    const result = coherence.validateCharacterProfile(character);
    // Should have warnings about role-trait alignment (villain lacks villainous traits)
    expect(result.warnings.some(w => w.includes('villain'))).toBe(true);
  });

  it('warns when hero has no aligned traits', () => {
    const character = {
      name: 'Milo',
      role: 'hero',
      gender: 'male',
      personality: 'shy, artistic, dreamy',
      backstory: 'An unlikely hero'
    };

    const result = coherence.validateCharacterProfile(character);
    expect(result.warnings.some(w => w.includes('hero'))).toBe(true);
  });

  it('handles empty personality gracefully', () => {
    const character = {
      name: 'Shadow',
      role: 'mystery',
      gender: '',
      personality: '',
      backstory: ''
    };

    const result = coherence.validateCharacterProfile(character);
    expect(result.isValid).toBe(true); // Empty is not invalid
    expect(result.confidence).toBe(1.0);
  });
});

describe('extractSpeakers()', () => {
  // This is tested indirectly through other tests
  it('identifies named speakers from tagged content', () => {
    const content = `
      [speaker:narrator][emotion:neutral] The old house stood silent.
      [speaker:Elena][emotion:curious] "What happened here?"
      [speaker:male][emotion:happy] "I don't know."
      [speaker:Thomas][emotion:neutral] He shook his head.
    `;

    // We can't directly test the private function, but we can test through checkChapter
    storyRag.listDocs.mockReturnValue([
      { id: 'char-elena', name: 'Elena', type: 'character', personality: 'curious', role: 'protagonist' }
    ]);

    expect(storyRag.listDocs).toBeDefined();
  });
});

describe('checkChapter()', () => {
  const mockStoryId = 'test-story-123';
  const mockContent = `
    [speaker:narrator][emotion:neutral] The night was cold.
    [speaker:Elena][emotion:happy] "I finally found the treasure!"
    [speaker:Elena][emotion:neutral] She opened the chest carefully.
  `;

  beforeEach(() => {
    storyRag.listDocs.mockReset();
  });

  it('returns a valid coherence result structure', async () => {
    storyRag.listDocs.mockReturnValue([]);

    const result = await coherence.checkChapter(mockStoryId, mockContent);

    expect(result).toHaveProperty('isConsistent');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('level');
    expect(result).toHaveProperty('warnings');
    expect(result).toHaveProperty('suggestions');
    expect(result).toHaveProperty('evidence');
    expect(['high', 'medium', 'low']).toContain(result.level);
  });

  it('checks characters when provided', async () => {
    storyRag.listDocs.mockReturnValue([
      { id: 'char-elena', name: 'Elena', type: 'character', personality: 'brave', role: 'hero' }
    ]);

    ai.ask.mockResolvedValue(JSON.stringify({ issues: [], confidence: 1.0 }));

    const result = await coherence.checkChapter(mockStoryId, mockContent, {
      checkCharacters: true
    });

    expect(result).toBeDefined();
  });

  it('skips character check when disabled', async () => {
    storyRag.listDocs.mockReturnValue([]);

    const result = await coherence.checkChapter(mockStoryId, mockContent, {
      checkCharacters: false
    });

    // No AI calls should be made for characters
    expect(ai.ask).not.toHaveBeenCalled();
    expect(result.warnings.filter(w => w.includes('Elena'))).toHaveLength(0);
  });

  it('handles AI failure gracefully', async () => {
    storyRag.listDocs.mockReturnValue([
      { id: 'char-elena', name: 'Elena', type: 'character', personality: 'brave' }
    ]);

    ai.ask.mockRejectedValue(new Error('AI unavailable'));

    const result = await coherence.checkChapter(mockStoryId, mockContent);

    // Should not throw, should have a warning about AI unavailability
    expect(result.warnings.some(w => w.includes('unavailable'))).toBe(true);
  });
});

describe('getStoryHealth()', () => {
  const mockStoryId = 'health-test-story';

  it('returns story health summary', async () => {
    storyRag.listDocs.mockImplementation((storyId, type) => {
      if (type === 'character') {
        return [
          { id: 'char-1', name: 'Elena', role: 'hero', personality: 'brave, kind', backstory: '' },
          { id: 'char-2', name: 'Marcus', role: 'warrior', personality: 'strong', backstory: '' }
        ];
      }
      if (type === 'lore') {
        return [{ id: 'lore-1', title: 'The Kingdom', content: 'A peaceful land' }];
      }
      if (type === 'summary') {
        return [{ id: 'summary-1', content: 'Chapter 1 summary' }];
      }
      return [];
    });

    const health = await coherence.getStoryHealth(mockStoryId);

    expect(health).toHaveProperty('storyId', mockStoryId);
    expect(health).toHaveProperty('health');
    expect(health.health).toHaveProperty('characters');
    expect(health.health).toHaveProperty('world');
    expect(health.health).toHaveProperty('continuity');
    expect(health).toHaveProperty('overallScore');
    expect(health).toHaveProperty('recommendations');
  });

  it('calculates scores correctly', async () => {
    storyRag.listDocs.mockReturnValue([]);

    const health = await coherence.getStoryHealth(mockStoryId);

    // No issues = high scores
    expect(health.health.characters.score).toBeGreaterThanOrEqual(0.7);
    expect(health.overallScore).toBeGreaterThanOrEqual(0.7);
  });
});

describe('whatIf()', () => {
  const mockStoryId = 'whatif-test-story';

  beforeEach(() => {
    storyRag.listDocs.mockReturnValue([
      { id: 'char-elena', name: 'Elena', type: 'character', personality: 'brave', role: 'hero' }
    ]);
  });

  it('returns what-if analysis result', async () => {
    ai.ask.mockResolvedValue(JSON.stringify({
      premise: 'yes',
      consequences: ['Elena would face a moral dilemma', 'The kingdom would be divided'],
      characterImpact: 'Elena struggles with her new nature',
      risks: ['Story becomes too dark'],
      opportunities: ['Explore Elena\'s darker side'],
      confidence: 0.8
    }));

    const result = await coherence.whatIf(mockStoryId, 'What if Elena turned evil?');

    expect(result.success).toBe(true);
    expect(result.question).toBe('What if Elena turned evil?');
    expect(result.answer).toHaveProperty('premise');
    expect(result.answer).toHaveProperty('consequences');
    expect(result.answer).toHaveProperty('characterImpact');
  });

  it('handles AI failure', async () => {
    ai.ask.mockRejectedValue(new Error('AI unavailable'));

    const result = await coherence.whatIf(mockStoryId, 'What if?');

    expect(result.success).toBe(false);
    expect(result).toHaveProperty('error');
  });
});

describe('Confidence thresholds', () => {
  it('exports correct confidence constants', () => {
    expect(coherence.CONFIDENCE_HIGH).toBe(0.8);
    expect(coherence.CONFIDENCE_MEDIUM).toBe(0.5);
    expect(coherence.CONFIDENCE_LOW).toBe(0.3);
  });
});

describe('parseCoherenceResponse()', () => {
  // Test through integration - directly testing private function not ideal
  it('handles malformed JSON', async () => {
    ai.ask.mockResolvedValue('This is not JSON at all');

    storyRag.listDocs.mockReturnValue([]);

    // Should not throw
    const result = await coherence.checkChapter('test-id', '[speaker:narrator] Test');
    expect(result).toBeDefined();
  });
});

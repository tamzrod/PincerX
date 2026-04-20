'use strict';

const http = require('http');
const { EventEmitter } = require('events');

// We need ai.js loaded fresh for each test to avoid module-cache interference
let ai;

beforeEach(() => {
  jest.resetModules();
  // Suppress startup log noise in tests
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ai = require('../openclaw/ai');
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Helper to mock http.request with a given response body. */
function mockHttpRequest(responseBody, statusCode = 200) {
  const mockRes = Object.assign(new EventEmitter(), { statusCode });
  const mockReq = Object.assign(new EventEmitter(), {
    write: jest.fn(),
    end: jest.fn(() => {
      // Emit response data asynchronously so the promise can wire up first
      setImmediate(() => {
        mockRes.emit('data', JSON.stringify(responseBody));
        mockRes.emit('end');
      });
    }),
  });

  jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
    cb(mockRes);
    return mockReq;
  });

  return { mockReq, mockRes };
}

/** Helper to mock a network error. */
function mockHttpRequestError(errorMessage) {
  const mockReq = Object.assign(new EventEmitter(), {
    write: jest.fn(),
    end: jest.fn(() => {
      setImmediate(() => mockReq.emit('error', new Error(errorMessage)));
    }),
  });

  jest.spyOn(http, 'request').mockImplementation(() => mockReq);

  return mockReq;
}

describe('OpenClaw ai.js', () => {
  describe('ask()', () => {
    it('returns the response string from a successful AI call', async () => {
      mockHttpRequest({ response: 'Hello from AI' });

      const result = await ai.ask('What is Node.js?');
      expect(result).toBe('Hello from AI');
    });

    it('uses default model and base URL', async () => {
      const { mockReq } = mockHttpRequest({ response: 'ok' });
      await ai.ask('test prompt');

      expect(http.request).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: 'localhost',
          path: '/api/generate',
          method: 'POST',
        }),
        expect.any(Function)
      );

      const bodyArg = JSON.parse(mockReq.write.mock.calls[0][0]);
      expect(bodyArg.model).toBe('llama3');
      expect(bodyArg.stream).toBe(false);
      expect(bodyArg.prompt).toBe('test prompt');
    });

    it('accepts custom baseUrl and model via options', async () => {
      const { mockReq } = mockHttpRequest({ response: 'custom' });

      await ai.ask('prompt', { baseUrl: 'http://myhost:9000', model: 'mistral' });

      expect(http.request).toHaveBeenCalledWith(
        expect.objectContaining({ hostname: 'myhost', port: '9000' }),
        expect.any(Function)
      );
      const body = JSON.parse(mockReq.write.mock.calls[0][0]);
      expect(body.model).toBe('mistral');
    });

    it('resolves with empty string when response field is absent', async () => {
      mockHttpRequest({ done: true }); // no 'response' field
      const result = await ai.ask('prompt');
      expect(result).toBe('');
    });

    it('rejects when the AI returns an error field', async () => {
      mockHttpRequest({ error: 'model not found' });
      await expect(ai.ask('prompt')).rejects.toThrow('AI error: model not found');
    });

    it('extracts message from an error object returned by the AI', async () => {
      mockHttpRequest({ error: { message: 'rate limit exceeded', code: 429 } });
      await expect(ai.ask('prompt')).rejects.toThrow('AI error: rate limit exceeded');
    });

    it('falls back to JSON.stringify when error object has no message field', async () => {
      mockHttpRequest({ error: { code: 'unknown' } });
      await expect(ai.ask('prompt')).rejects.toThrow('AI error: {"code":"unknown"}');
    });

    it('rejects when the response body is not valid JSON', async () => {
      const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
      const mockReq = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        end: jest.fn(() => {
          setImmediate(() => {
            mockRes.emit('data', 'not-json!!!');
            mockRes.emit('end');
          });
        }),
      });
      jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
        cb(mockRes);
        return mockReq;
      });

      await expect(ai.ask('prompt')).rejects.toThrow('Failed to parse AI response');
    });

    it('rejects on network error', async () => {
      mockHttpRequestError('ECONNREFUSED');
      await expect(ai.ask('prompt')).rejects.toThrow(
        'AI request failed (http://localhost:11434, model=llama3): ECONNREFUSED'
      );
    });
  });

  describe('timeout and race-condition behaviour', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('rejects with a timeout error when timeoutMs elapses before a response', async () => {
      const mockReq = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        end: jest.fn(),
        // Simulate Node.js: destroy(err) emits 'error' on the request
        destroy: jest.fn(function (err) { this.emit('error', err); }),
      });

      jest.spyOn(http, 'request').mockImplementation(() => mockReq);

      const promise = ai.ask('prompt', { timeoutMs: 5000 });

      jest.advanceTimersByTime(5000);

      await expect(promise).rejects.toThrow(
        'AI request failed (http://localhost:11434, model=llama3): AI request timed out'
      );
      expect(mockReq.destroy).toHaveBeenCalledTimes(1);
    });

    it('does not call req.destroy() and clears the timer after a successful response', async () => {
      const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
      const mockReq = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        destroy: jest.fn(),
        // Emit response synchronously so the promise settles before timer fires
        end: jest.fn(function () {
          mockRes.emit('data', JSON.stringify({ response: 'hello' }));
          mockRes.emit('end');
        }),
      });

      jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
        cb(mockRes);
        return mockReq;
      });

      const result = await ai.ask('prompt', { timeoutMs: 5000 });
      expect(result).toBe('hello');

      // Advance past the timeout deadline – destroy must never be called
      jest.advanceTimersByTime(6000);
      expect(mockReq.destroy).not.toHaveBeenCalled();
    });

    it('does not reject twice when timeout fires after a successful response', async () => {
      const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
      const mockReq = Object.assign(new EventEmitter(), {
        write: jest.fn(),
        destroy: jest.fn(function (err) { this.emit('error', err); }),
        end: jest.fn(function () {
          mockRes.emit('data', JSON.stringify({ response: 'done' }));
          mockRes.emit('end');
        }),
      });

      jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
        cb(mockRes);
        return mockReq;
      });

      const result = await ai.ask('prompt', { timeoutMs: 5000 });
      expect(result).toBe('done');

      // Simulate a late timeout firing – should be a no-op
      jest.advanceTimersByTime(6000);
      // If destroy were called and emitted 'error', a second rejection would be
      // unhandled and cause the test to fail – so reaching here is the assertion.
      expect(mockReq.destroy).not.toHaveBeenCalled();
    });
  });
});

describe('normalizeBaseUrl()', () => {
  let normalizeBaseUrl;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ({ normalizeBaseUrl } = require('../openclaw/ai'));
  });

  it('returns a valid URL unchanged', () => {
    expect(normalizeBaseUrl('http://localhost:11434')).toBe('http://localhost:11434');
  });

  it('removes trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:11434/')).toBe('http://localhost:11434');
    expect(normalizeBaseUrl('http://localhost:11434///')).toBe('http://localhost:11434');
  });

  it('adds http:// prefix when no protocol is given', () => {
    expect(normalizeBaseUrl('localhost:11434')).toBe('http://localhost:11434');
  });

  it('accepts https:// URLs', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe('https://api.example.com');
  });

  it('throws for an empty string', () => {
    expect(() => normalizeBaseUrl('')).toThrow('Invalid AI_BASE_URL configuration');
  });

  it('throws for a bare "http" without a hostname', () => {
    expect(() => normalizeBaseUrl('http')).toThrow('Invalid AI_BASE_URL configuration');
  });

  it('throws for a bare "https" without a hostname', () => {
    expect(() => normalizeBaseUrl('https')).toThrow('Invalid AI_BASE_URL configuration');
  });

  it('throws for undefined', () => {
    expect(() => normalizeBaseUrl(undefined)).toThrow('Invalid AI_BASE_URL configuration');
  });

  it('throws for null', () => {
    expect(() => normalizeBaseUrl(null)).toThrow('Invalid AI_BASE_URL configuration');
  });

  it('throws when the URL contains a duplicated protocol (http://http://...)', () => {
    expect(() => normalizeBaseUrl('http://http://localhost')).toThrow(
      'Invalid AI_BASE_URL configuration'
    );
  });
});

describe('listModels()', () => {
  /** Helper: mock http.request to respond with a given body on the first GET. */
  function mockGetRequest(responseBody) {
    const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
    const mockReq = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(() => {
        setImmediate(() => {
          mockRes.emit('data', JSON.stringify(responseBody));
          mockRes.emit('end');
        });
      }),
    });

    jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
      cb(mockRes);
      return mockReq;
    });

    return { mockReq, mockRes };
  }

  /** Helper: mock a network error on http.request. */
  function mockGetError(errorMessage) {
    const mockReq = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(() => {
        setImmediate(() => mockReq.emit('error', new Error(errorMessage)));
      }),
    });
    jest.spyOn(http, 'request').mockImplementation(() => mockReq);
    return mockReq;
  }

  it('returns model names from a successful /api/tags response', async () => {
    mockGetRequest({ models: [{ name: 'llama3' }, { name: 'mistral' }] });
    const models = await ai.listModels();
    expect(models).toEqual(['llama3', 'mistral']);
  });

  it('returns an empty array when the models field is absent', async () => {
    mockGetRequest({ something: 'else' });
    const models = await ai.listModels();
    expect(models).toEqual([]);
  });

  it('filters out model entries with no name', async () => {
    mockGetRequest({ models: [{ name: 'llama3' }, {}, { name: '' }] });
    const models = await ai.listModels();
    expect(models).toEqual(['llama3']);
  });

  it('rejects when the network request fails', async () => {
    mockGetError('ECONNREFUSED');
    await expect(ai.listModels()).rejects.toThrow('Failed to list models: ECONNREFUSED');
  });

  it('rejects when the response body is not valid JSON', async () => {
    const mockRes = Object.assign(new EventEmitter(), { statusCode: 200 });
    const mockReq = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(() => {
        setImmediate(() => {
          mockRes.emit('data', 'not-json!');
          mockRes.emit('end');
        });
      }),
    });
    jest.spyOn(http, 'request').mockImplementation((_opts, cb) => {
      cb(mockRes);
      return mockReq;
    });
    await expect(ai.listModels()).rejects.toThrow('Failed to parse model list');
  });

  it('uses a custom baseUrl when provided in options', async () => {
    mockGetRequest({ models: [{ name: 'gemma' }] });
    const models = await ai.listModels({ baseUrl: 'http://myhost:9000' });
    expect(models).toEqual(['gemma']);
    expect(http.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'myhost', port: '9000', path: '/api/tags', method: 'GET' }),
      expect.any(Function)
    );
  });

  it('throws when baseUrl is invalid', async () => {
    await expect(ai.listModels({ baseUrl: 'http' })).rejects.toThrow(
      'Invalid AI_BASE_URL configuration'
    );
  });
});

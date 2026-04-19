'use strict';

const http = require('http');
const { EventEmitter } = require('events');

// We need ai.js loaded fresh for each test to avoid module-cache interference
let ai;

beforeEach(() => {
  jest.resetModules();
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
      await expect(ai.ask('prompt')).rejects.toThrow('AI request failed: ECONNREFUSED');
    });
  });
});

# PincerX Architecture

## Overview

PincerX is a Node.js application composed of two layers:

- **PincerX API** (`api/server.js`) — an Express HTTP server that exposes two endpoints.
- **OpenClaw** (`openclaw/`) — the core engine with three modules: `rag.js`, `feedback.js`, and `ai.js`.

All AI inference is delegated to a local [Ollama](https://ollama.com/) backend over HTTP.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    PincerX API                          │
│                  api/server.js                          │
│                                                         │
│   POST /ask ──────────────► rag.ask()                   │
│   POST /analyze ──────────► feedback.analyze()          │
└───────────────────────┬─────────────────────────────────┘
                        │
          ┌─────────────▼──────────────┐
          │        OpenClaw            │
          │                            │
          │  rag.js      feedback.js   │
          │     └────────────┘         │
          │           │                │
          │         ai.js              │
          └───────────┬────────────────┘
                      │
          ┌───────────▼────────────────┐
          │   Ollama backend           │
          │   POST /api/generate       │
          │   (localhost:11434)        │
          └────────────────────────────┘

          ┌────────────────────────────┐
          │   data/docs.json           │
          │   (knowledge base)         │
          └─────────────▲──────────────┘
                        │
                   rag.js (retrieve)
```

---

## Component Interaction

### `POST /ask` request path

```
Client
  │
  ▼
server.js        validates { query }
  │
  ▼
rag.ask(query)
  │
  ├── retrieve(query)        keyword-scores docs.json, returns top-K docs
  │       └── loadDocs()     reads data/docs.json from disk (sync)
  │
  ├── builds grounded prompt (context + question)
  │
  └── ai.ask(prompt)
          │
          └── Ollama POST /api/generate
                  │
                  └── returns { response: "..." }

Response: { answer: string, sources: [{id, title}] }
```

### `POST /analyze` request path

```
Client
  │
  ▼
server.js          validates { text }
  │
  ▼
feedback.analyze(text)
  │
  ├── builds JSON-instruction prompt
  │
  └── ai.ask(prompt)
          │
          └── Ollama POST /api/generate
                  │
                  └── returns raw JSON string

  feedback.js then:
    parseAnalysis(raw)
      ├── regex-extracts first { ... } block
      ├── JSON.parse()
      ├── normalizeSentiment()   → "positive" | "negative" | "neutral"
      └── on any failure → buildFallback()

Response: { sentiment, topic, suggestions[] }
```

---

## Request Lifecycle — `POST /ask`

| Step | Location | Detail |
|------|----------|--------|
| 1 | `server.js` | Validates `req.body.query` — must be a non-empty string; returns 400 otherwise |
| 2 | `rag.ask()` | Calls `retrieve(query)` |
| 3 | `rag.retrieve()` | Reads `data/docs.json` synchronously; strips punctuation; splits query into keywords (>2 chars) |
| 4 | `rag.retrieve()` | Scores each document by counting keyword occurrences in `title + content`; returns top-3 by score |
| 5 | `rag.ask()` | If no docs score >0, returns early: `{ answer: "No relevant information…", sources: [] }` |
| 6 | `rag.ask()` | Joins retrieved docs into a context block; builds a grounded prompt |
| 7 | `ai.ask()` | Opens an HTTP connection to Ollama; sends `{ model, prompt, stream: false }` |
| 8 | `ai.ask()` | Collects streamed chunks; on `end`, JSON-parses the response; resolves with `parsed.response` |
| 9 | `server.js` | Returns `{ answer, sources }` as JSON; on rejection returns 502 |

---

## Request Lifecycle — `POST /analyze`

| Step | Location | Detail |
|------|----------|--------|
| 1 | `server.js` | Validates `req.body.text` — must be a non-empty string; returns 400 otherwise |
| 2 | `feedback.analyze()` | Builds a strict JSON-instruction prompt instructing the model to respond with only a JSON object |
| 3 | `ai.ask()` | Sends prompt to Ollama; collects and parses response |
| 4 | `feedback.parseAnalysis()` | Regex-extracts the first `{…}` block from the raw string |
| 5 | `feedback.parseAnalysis()` | `JSON.parse()`s the block; normalizes `sentiment` via `normalizeSentiment()` |
| 6 | `feedback.parseAnalysis()` | On any parse failure, returns `buildFallback()` — never throws |
| 7 | `server.js` | Returns `{ sentiment, topic, suggestions }` as JSON; on rejection returns 502 |

---

## Error Handling Flow

```
┌─────────────┬────────────────────────────────────────────────────────────────┐
│ Layer        │ Behaviour                                                      │
├─────────────┼────────────────────────────────────────────────────────────────┤
│ server.js    │ 400 – missing/empty body field                                │
│ server.js    │ 502 – any uncaught rejection from rag.js or feedback.js       │
│ rag.js       │ Early return (no throw) when no docs match (score == 0)       │
│ feedback.js  │ parseAnalysis() returns buildFallback() on regex/parse failure│
│ ai.js        │ Rejects on HTTP error, Ollama error field, or JSON parse fail  │
│ ai.js        │ Rejects with timeout error after timeoutMs (default 30 s)     │
└─────────────┴────────────────────────────────────────────────────────────────┘
```

---

## AI Adapter Flow (`openclaw/ai.js`)

```
ai.ask(prompt, options)
  │
  ├── Resolves base URL, model, and timeoutMs from options or defaults
  │
  ├── Creates http.request to Ollama /api/generate
  │
  ├── Sets settled = false and starts timeout timer
  │
  ├── On response end:
  │     settle() → clearTimeout, JSON.parse, resolve(parsed.response)
  │
  ├── On request error:
  │     settle() → clearTimeout, reject(err)
  │
  └── On timeout:
        if !settled → req.destroy(new Error('AI request timed out'))
        req.destroy triggers 'error' event → settle() → reject
```

**Double-settle guard:** The `settled` flag plus the `settle()` helper ensure that only one of success, error, or timeout can ever resolve or reject the promise. `clearTimeout()` inside `settle()` prevents timer leaks when the response arrives before the deadline.

---

## Module Boundary Summary

| Consumer | Dependency | Contract |
|----------|-----------|----------|
| `server.js` | `rag.js` | `rag.ask(query: string) → Promise<{answer, sources}>` |
| `server.js` | `feedback.js` | `feedback.analyze(text: string) → Promise<{sentiment, topic, suggestions}>` |
| `rag.js` | `ai.js` | `ai.ask(prompt: string, options?) → Promise<string>` |
| `feedback.js` | `ai.js` | `ai.ask(prompt: string, options?) → Promise<string>` |
| `rag.js` | `data/docs.json` | Array of `{id, title, content}` objects (read synchronously) |
| `ai.js` | Ollama HTTP API | `POST /api/generate` — request `{model, prompt, stream}`, response `{response}` |

Each module is isolated: `server.js` never calls `ai.js` directly, and `ai.js` has no knowledge of the knowledge base or prompt strategy.

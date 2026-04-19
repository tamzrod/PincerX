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

---

## System Invariants

The following rules must never be violated. A change that breaks any invariant is a correctness defect regardless of whether existing tests catch it.

| # | Invariant | Where enforced |
|---|-----------|----------------|
| I-1 | `server.js` never imports `ai.js` directly. All AI access is mediated by `rag.js` or `feedback.js`. | Module boundary (import graph) |
| I-2 | `ai.js` has no knowledge of prompt strategy, knowledge base, or response parsing. It is a pure HTTP transport. | `openclaw/ai.js` — contains no domain logic |
| I-3 | `parseAnalysis()` in `feedback.js` must never throw. Every code path returns a structurally valid `{sentiment, topic, suggestions}` object, falling back to `buildFallback()` on any failure. | `feedback.js:parseAnalysis()` |
| I-4 | `normalizeSentiment()` must return exactly one of `"positive"`, `"negative"`, or `"neutral"`. No other value may reach the API response. | `feedback.js:normalizeSentiment()` |
| I-5 | `retrieve()` must never return a document whose keyword score is 0. Only positively-scored documents may reach the prompt builder. | `rag.js:retrieve()` — `filter(({ score }) => score > 0)` |
| I-6 | `rag.ask()` must not call `ai.ask()` when `retrieve()` returns an empty array. The early-return path exists to prevent context-free prompts reaching the model. | `rag.js:ask()` |
| I-7 | Query keywords of two characters or fewer are discarded before scoring. Stop-word filtering is a precondition of retrieval correctness. | `rag.js:retrieve()` — `filter((w) => w.length > 2)` |
| I-8 | The `settled` flag in `ai.js` guarantees the returned `Promise` is resolved or rejected exactly once. Neither double-resolve nor double-reject may occur regardless of the order in which success, network error, and timeout events fire. | `ai.js:settle()` |
| I-9 | All API error responses must be JSON objects with an `error` field. No plain-text or HTML error bodies may be returned. | `server.js` — all `res.status(4xx/5xx).json(...)` calls |
| I-10 | `timeoutMs` in `ai.js` defaults to 30 000 ms. Any caller that overrides this must supply a positive integer; a value of `0` or `undefined` must never disable the timeout silently. | `ai.js` — `options.timeoutMs !== undefined ? options.timeoutMs : DEFAULT_TIMEOUT_MS` |

---

## Performance Limitations and Scaling Notes

### Current bottlenecks

| Area | Detail | Impact |
|------|--------|--------|
| Synchronous disk read | `rag.js:loadDocs()` calls `fs.readFileSync()` on every request. There is no in-memory cache or lazy-load. | Blocks the event loop thread on every `/ask` call; scales linearly with request rate. |
| Regex compilation per retrieval | `retrieve()` compiles a `new RegExp(kw, 'g')` for every keyword × every document pair. At Q keywords and D documents, scoring is O(Q × D) regex operations per request. | Becomes measurable at large doc counts or high concurrency. |
| No connection reuse to Ollama | `ai.js` opens a new `http.request` for every call. Node.js's `http.globalAgent` pools connections by default, but no explicit keep-alive tuning is applied. | Adds TCP handshake overhead on each inference call. |
| Blocking AI inference, no streaming | `stream: false` is hardcoded. The full model response is buffered server-side before any bytes reach the client. | P95 latency equals model TTFT + total generation time; the client sees nothing until the model is done. |
| No request queue or concurrency cap | `server.js` forwards every concurrent request directly to Ollama. There is no semaphore or queue in front of the AI layer. | Concurrent requests produce concurrent Ollama inference jobs, which compete for GPU/CPU and degrade throughput non-linearly under load. |

### Scaling boundaries

- **Knowledge base size:** `docs.json` is fully loaded and linearly scanned on every request. Performance degrades noticeably above a few hundred documents. A vector index or inverted-index cache would be required for larger corpora.
- **Concurrency:** The single Node.js process handles all requests on one event loop thread. CPU-bound retrieval (large doc sets) blocks I/O. Horizontal scaling requires multiple processes behind a reverse proxy (e.g., nginx + PM2 cluster mode).
- **Model latency:** Ollama inference time dominates end-to-end latency. The 30-second default timeout is appropriate for local LLM hardware but must be tuned if a remote or slower backend is used.
- **Memory:** With the current synchronous `readFileSync` pattern, `docs.json` is parsed into a new object graph on every call. For large files this increases GC pressure proportionally with request rate.

---

## Testing Strategy Overview

Tests live in `tests/` and are run with `npm test` (Jest with `--coverage`). Coverage is collected from `openclaw/**/*.js` and `api/**/*.js`.

### Test files and their scope

| File | Module under test | Technique | What it covers |
|------|-------------------|-----------|----------------|
| `tests/ai.test.js` | `openclaw/ai.js` | Unit — mocks `http.request` directly via `jest.spyOn` | Successful response, custom `baseUrl`/`model` options, missing `response` field, `error` field in payload, malformed JSON body, network error (`ECONNREFUSED`), timeout expiry, and the double-settle race condition |
| `tests/rag.test.js` | `openclaw/rag.js` | Unit — mocks `ai.js` via `jest.mock('../openclaw/ai')` | Keyword ranking, empty-match return, `topK` limiting, stop-word filtering, doc field shape, grounded-prompt content, no-match early return, `aiOptions` forwarding, and AI error propagation |
| `tests/feedback.test.js` | `openclaw/feedback.js` | Unit — mocks `ai.js` via `jest.mock('../openclaw/ai')` | Positive/negative/neutral sentiment, unknown sentiment normalization, case normalization, non-array `suggestions` fallback, no-JSON-object fallback, malformed JSON fallback, non-string `topic` fallback, `aiOptions` forwarding, strict JSON prompt content, and AI error propagation |
| `tests/server.test.js` | `api/server.js` | Integration — mounts the Express app via `supertest`; mocks `rag.js` and `feedback.js` | 200 responses with correct shape, input trimming, 400 on missing/empty/blank/non-string fields, 502 on downstream rejection, and error message content |

### Design principles

- **No real I/O in any test.** `http.request` (in `ai.test.js`) and both OpenClaw modules (in `server.test.js`) are mocked. Tests execute without a running Ollama instance or a file system containing `docs.json` (except `rag.test.js`, which reads the real `data/docs.json` for retrieval correctness tests).
- **`jest.resetModules()` in `ai.test.js`** re-requires `ai.js` before every test to prevent module-cache state from leaking between timer-mock and real-timer tests.
- **Fake timers (`jest.useFakeTimers()`)** are scoped to the timeout `describe` block in `ai.test.js` and restored in `afterEach` to avoid polluting other tests.
- **Error-path coverage:** Every documented fallback (`buildFallback`, 400 validation, 502 upstream error) has at least one dedicated test case.

---

## Safety Model for AI Outputs and Future Automation

### Current defenses

The system applies a layered defence-in-depth approach to AI outputs, treating all model responses as untrusted strings until explicitly validated.

**Layer 1 — Prompt constraints (pre-inference)**

- `rag.js` instructs the model: *"Answer the question using ONLY the context provided below. Do not invent information that is not present in the context."* This is a prompt-level hallucination guard; the model is given no information beyond the retrieved documents.
- `feedback.js` instructs the model: *"respond with ONLY a valid JSON object"* with a prescribed schema and field constraints. Free-form prose in the response is a model error, not a valid output.
- `rag.ask()` short-circuits before calling the model when no documents match the query (Invariant I-6). This prevents the model from being prompted with an empty context window, which increases hallucination risk.

**Layer 2 — Output parsing and normalization (post-inference)**

- `feedback.js:parseAnalysis()` never trusts the raw model string. It:
  1. Regex-extracts the first `{…}` block to tolerate preamble or postamble prose.
  2. `JSON.parse()`s the extracted block.
  3. Type-checks every field (`sentiment` via allowlist, `topic` as string, `suggestions` as array).
  4. Falls back to `buildFallback()` on any failure — a structurally valid, semantically neutral response.
- `normalizeSentiment()` enforces an explicit allowlist `['positive', 'negative', 'neutral']`. Any value outside the allowlist, including casing variants or novel terms, collapses to `'neutral'`. Model outputs cannot inject new sentiment categories.

**Layer 3 — API surface isolation**

- `ai.js` surfaces Ollama errors as rejected Promises with prefixed messages (`"AI error: …"`, `"AI request failed: …"`). No raw Ollama error payload is forwarded to the HTTP client.
- `server.js` catches all downstream rejections and returns a generic `502` with the error message string. The client never receives a stack trace or internal system detail.

### Rules for future automation

If future work adds code paths that act on AI output (e.g., triggering side effects, writing to a database, invoking external services), the following rules apply:

1. **Validate before acting.** Any structured AI output that drives a side effect must be validated against an explicit schema before the action is taken. `feedback.js:parseAnalysis()` is the reference implementation of this pattern.
2. **Allowlist, do not blocklist.** Accepted values (sentiment categories, action types, etc.) must be defined as explicit allowlists. Unexpected values must be rejected or collapsed to a safe default, never passed through.
3. **No direct code execution from AI output.** Model responses must never be evaluated as code, used as shell arguments, or interpolated into SQL/HTML without escaping. This applies even when the prompt constrains the output format.
4. **Human-in-the-loop for high-impact actions.** Any action that is irreversible (e.g., sending an email, modifying a record, triggering a deployment) must require explicit human confirmation before execution, regardless of model confidence.
5. **Timeout and fallback on every inference call.** All calls to `ai.ask()` must respect a timeout (Invariant I-10). Automation pipelines must define a safe fallback for the timeout case and must not block indefinitely waiting for model output.

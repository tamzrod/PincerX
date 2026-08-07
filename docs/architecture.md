# PincerX Architecture

## Overview

PincerX is a local creative storytelling system that generates stories with AI, maintains character profiles and lore, and renders narratives with multi-voice TTS narration via Zonos.

The application is organized into four functional areas:

- **Story Engine** (`story/`) — story creation, chapter generation, character extraction, and voice assignment
- **Story Knowledge** (`story/story-rag.js`) — per-story knowledge store with expanded types
- **Story Coherence** (`story/story-coherence.js`) — narrative consistency validation (KDE-inspired)
- **Core Libraries** (`lib/`) — AI transport, document retrieval, and text analysis
- **HTTP API** (`api/server.js`) — Express endpoints for all client interactions

All AI inference is delegated to a local [Ollama](https://ollama.com/) backend (or OpenAI-compatible APIs like Groq/OpenRouter) over HTTP.

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    PincerX API                          │
│                  api/server.js                          │
│                                                         │
│   Story endpoints ──────────────► story.js             │
│   Story Knowledge endpoints ─────► story-rag.js       │
│   Coherence endpoints ─────────► story-coherence.js    │
│   TTS endpoints ────────────────► Zonos sidecar       │
│   Config endpoints ─────────────► lib/ai.js            │
│   (Legacy RAG) ────────────────► lib/rag.js           │
└─────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         │                    │                    │
         ▼                    ▼                    ▼
   ┌──────────┐        ┌──────────┐        ┌──────────┐
   │ lib/ai.js│        │lib/rag.js│        │story-rag │
   │          │        │          │        │   .js    │
   └────┬─────┘        └────┬─────┘        └────┬─────┘
        │                   │                    │
        ▼                   ▼                    │
  ┌──────────┐        ┌──────────┐             │
  │ Ollama   │        │  data/   │             │
  │ backend  │        │docs.json │             │
  └──────────┘        └──────────┘             │
                                                 │
              ┌────────────────────────────────┘
              ▼
        ┌──────────────────┐
        │  data/stories/   │
        │  (per-story JSON)│
        │  rag-docs.json   │
        └──────────────────┘
```

---

## Directory Structure

```
PincerX/
├── api/
│   └── server.js          # Express HTTP server (all routes)
├── lib/
│   ├── ai.js             # Pure LLM HTTP transport
│   ├── rag.js            # Generic document retrieval (legacy/generic RAG)
│   └── feedback.js       # Text analysis (sentiment, suggestions)
├── story/
│   ├── story.js          # Story creation, chapter generation
│   ├── story-rag.js      # Per-story knowledge store (expanded types)
│   └── story-coherence.js # Narrative consistency validation (KDE-inspired)
├── zonos/
│   ├── server.py         # Zonos TTS sidecar (Python)
│   ├── Dockerfile
│   └── requirements.txt
├── public/
│   └── index.html       # Web UI for story management and TTS
├── data/
│   ├── stories/          # Persisted story JSON files + rag-docs.json
│   ├── tts-cache/       # Cached audio files
│   └── docs.json         # Generic knowledge base (for legacy /ask endpoint)
├── tests/                # Jest test suite
└── docs/                 # Documentation
```

---

## Core Modules

### `lib/ai.js` — AI Transport

A pure HTTP transport layer with no domain knowledge. It sends prompts to Ollama or OpenAI-compatible backends and returns the response text.

**Key functions:**
- `ask(prompt, options)` — Send a prompt and get a text response
- `listModels(options)` — Enumerate available models

**Supported providers:** Ollama, OpenAI, Groq, OpenRouter

### `story/story.js` — Story Engine

Handles the complete story creation and chapter generation workflow:

1. **Story creation** (`create()`) — Generates outline, characters, and locations from title/genre/tone
2. **Chapter generation** (`generateChapter()`) — Writes chapters with `[speaker:Name][emotion:X]` tags
3. **Auto-character extraction** — Detects new named speakers and creates minimal profiles
4. **Auto-knowledge extraction** — Extracts places, systems, arc boundaries from chapters
5. **Coherence checking** — Runs KDE-inspired consistency checks after generation
6. **Voice preset assignment** — Maps characters to Zonos voice presets based on gender/age

### `story/story-rag.js` — Per-Story Knowledge Store

Per-story document storage with expanded knowledge types supporting the anti-hallucination system:

**Supported Knowledge Types:**
| Type | Purpose | Key Fields |
|------|---------|------------|
| `character` | People, personalities, boundaries | name, role, gender, personality, backstory, context, boundary |
| `place` | Locations with constraints | title, description, constraints, context, boundary |
| `lore` / `world` | World rules and established facts | title, content, context, boundary |
| `system` | Magic, tech, cultivation, science rules | title, domain, content, context, boundary |
| `parameter` | Genre hard rules, tone limits, bans | title, content, bans, context, boundary |
| `arc_boundary` | What can/cannot happen in current arc | title, phase, constraints, allowedEvents, forbiddenEvents |
| `summary` | Chapter summaries for continuity | chapterNumber, content |

**Key functions:**
- `addDoc(storyId, doc)` — Add/update a document
- `listDocs(storyId, type)` — List docs, optionally filtered by type
- `listDocsByType(storyId)` — Get all docs grouped by type
- `upsertKnowledge(storyId, doc)` — Add or update with merge support
- `batchUpsert(storyId, docs)` — Efficiently add/update multiple docs
- `formatKnowledgeForPrompt(storyId, options)` — Format knowledge for AI prompts
- `retrieve(storyId, query, topK)` — Keyword-based retrieval

### `story/story-coherence.js` — Story Coherence Engine (KDE-Inspired)

A lightweight layer for validating narrative consistency, inspired by KDE Beta/Gamma reasoning patterns.

**KDE-ENGINE-002 (Beta) concepts:**
- **Context Detection**: Under what conditions is this story element valid?
- **Boundary Detection**: When does this rule/trait stop being true?
- **Confidence & Evidence**: Attaches confidence levels to coherence checks

**KDE-ENGINE-003 (Gamma) concepts:**
- **Causal Mechanism**: How events connect through motivation and consequence
- **Intervention Thinking**: "What if" analysis while staying grounded

**Key functions:**
- `checkChapter(storyId, content, options)` — Validates chapter consistency with characters, lore, and continuity
- `validateCharacterProfile(character)` — Checks character profile internal consistency
- `whatIf(storyId, question)` — Explores alternative story directions
- `getStoryHealth(storyId)` — Provides a quick story health summary

### `lib/rag.js` — Generic Document Retrieval

Legacy module for PDF-based question answering. Maintained for backward compatibility but not the primary use case.

---

## Story Knowledge System

PincerX implements a **living knowledge base** that grows with each chapter:

1. **Before generation**: Structured knowledge (parameters, arc boundaries, systems, characters, places, lore) is injected into the chapter prompt as "STORY LAW / KNOWLEDGE"
2. **After generation**: Auto-extraction runs to identify new knowledge elements (new places, systems, arc boundaries)
3. **Coherence check**: KDE-inspired consistency validation runs and returns warnings/suggestions
4. **User control**: Manual add/edit of knowledge items through the Story Knowledge UI panel

This architecture prevents hallucinations by ensuring:
- The model always has access to established rules
- New elements are explicitly added to the knowledge store
- Inconsistencies are flagged for review

---

## API Endpoints

### Story Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/story/list` | List all stories |
| POST | `/story/create` | Create a new story |
| GET | `/story/:id` | Get story details |
| DELETE | `/story/:id` | Delete a story |

### Chapter Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/story/:id/chapter` | Generate next chapter (returns coherence result) |
| PATCH | `/story/:id/chapter/:num` | Update chapter content |
| DELETE | `/story/:id/chapter/:num` | Delete a chapter |

### Character & Lore

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/story/:id/character` | Add a character |
| GET | `/story/:id/characters` | List characters |
| DELETE | `/story/:id/character/:charId` | Remove a character |
| POST | `/story/:id/lore` | Add lore entry |
| GET | `/story/:id/lore` | List lore entries |
| DELETE | `/story/:id/lore/:loreId` | Remove lore |

### Story Knowledge (New)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/story/:id/knowledge` | List all knowledge (optional `?type=` or `?groupBy=type`) |
| GET | `/story/:id/knowledge/:docId` | Get a specific knowledge document |
| POST | `/story/:id/knowledge` | Add/update a knowledge entry |
| DELETE | `/story/:id/knowledge/:docId` | Remove a knowledge entry |

### TTS (Zonos)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/tts` | Synthesize speech |
| POST | `/tts/cached` | Synthesize with caching |
| GET | `/tts/voices` | List available voices |
| GET | `/tts/voice-presets` | List voice presets |
| POST | `/story/:id/chapter/:num/tts-prebake` | Pre-generate chapter audio |

### Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/config` | Get AI configuration |
| POST | `/config` | Update AI configuration |
| GET | `/models` | List available AI models |

### Coherence & Story Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/story/:id/coherence/health` | Get story health summary |
| POST | `/story/:id/coherence/check` | Check chapter coherence |
| POST | `/story/:id/coherence/validate-character` | Validate character profile |
| POST | `/story/:id/coherence/whatif` | Explore "what if" scenarios |

### Legacy Endpoints (Demoted)

These endpoints remain for backward compatibility but are not emphasized in the UI:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/ask` | Generic document Q&A |
| POST | `/analyze` | Text analysis |
| GET | `/pdfs` | List uploaded PDFs |
| POST | `/upload` | Upload a PDF |
| DELETE | `/pdf` | Delete a PDF |

---

## Module Boundary Summary

| Consumer | Dependency | Contract |
|----------|-----------|----------|
| `server.js` | `story.js` | Story creation and chapter generation |
| `server.js` | `story-rag.js` | Knowledge management |
| `server.js` | `lib/ai.js` | Config validation, model listing |
| `server.js` | `lib/rag.js` | Legacy document Q&A |
| `server.js` | `lib/feedback.js` | Legacy text analysis |
| `story.js` | `lib/ai.js` | All AI inference calls |
| `story.js` | `story-rag.js` | Knowledge retrieval and storage |
| `story.js` | `story-coherence.js` | Coherence validation |
| `lib/rag.js` | `lib/ai.js` | Generic document Q&A |

---

## Error Handling

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad request (validation failure) |
| 404 | Resource not found |
| 502 | Upstream error (AI backend failure) |

All AI errors are caught at the API layer and returned as 502 with a descriptive message.

---

## Testing Strategy

Tests are located in `tests/` and run with `npm test` (Jest).

| File | Tests |
|------|-------|
| `tests/ai.test.js` | AI transport, timeout handling, model listing |
| `tests/rag.test.js` | Document retrieval and Q&A |
| `tests/feedback.test.js` | Text analysis and sentiment detection |
| `tests/story.test.js` | Story creation, chapter generation, character extraction |
| `tests/story-rag.test.js` | Per-story knowledge store operations (expanded types) |
| `tests/story-coherence.test.js` | Story coherence validation (KDE-inspired) |
| `tests/server.test.js` | API endpoint integration tests |

**Design principles:**
- No real AI calls in tests — all dependencies are mocked
- Fake timers used for timeout testing
- Each test cleans up its filesystem artifacts

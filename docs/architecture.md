# PincerX Architecture

## Overview

PincerX is a local creative storytelling system that generates stories with AI, maintains character profiles and lore, and renders narratives with multi-voice TTS narration via Zonos.

The application is organized into four functional areas:

- **Story Engine** (`story/`) — story creation, chapter generation, character extraction, and voice assignment
- **Story Coherence** (`story/story-coherence.js`) — narrative consistency validation
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
│   ├── story-rag.js      # Per-story knowledge store (characters, lore)
│   └── story-coherence.js # Narrative consistency validation
├── zonos/
│   ├── server.py         # Zonos TTS sidecar (Python)
│   ├── Dockerfile
│   └── requirements.txt
├── public/
│   └── index.html       # Web UI for story management and TTS
├── data/
│   ├── stories/          # Persisted story JSON files
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
4. **Voice preset assignment** — Maps characters to Zonos voice presets based on gender/age

### `story/story-rag.js` — Story Knowledge Store

Per-story document storage for:

- **Characters** — Name, role, gender, personality, backstory, voice ID
- **Lore** — Locations, world details, plot elements
- **Summaries** — Auto-generated chapter summaries for continuity

Uses keyword-based retrieval for context during chapter generation.

### `story/story-coherence.js` — Story Coherence Engine

A lightweight layer for validating narrative consistency, inspired by KDE Beta/Gamma reasoning patterns.

**Key Concepts:**
- **Context Detection**: Determines under what conditions a story element is valid
- **Boundary Detection**: Defines when rules or traits stop being applicable
- **Confidence & Evidence**: Attaches confidence levels to coherence checks
- **Causal Mechanism**: Explains how events connect through motivation and consequence
- **Intervention Thinking**: Supports "what if" analysis while staying grounded

**Key functions:**
- `checkChapter(storyId, content, options)` — Validates chapter consistency with characters, lore, and continuity
- `validateCharacterProfile(character)` — Checks character profile internal consistency
- `whatIf(storyId, question)` — Explores alternative story directions
- `getStoryHealth(storyId)` — Provides a quick story health summary

### `lib/rag.js` — Generic Document Retrieval

Legacy module for PDF-based question answering. Maintained for backward compatibility but not the primary use case.

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
| POST | `/story/:id/chapter` | Generate next chapter |
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
| `server.js` | `story-rag.js` | Character and lore management |
| `server.js` | `lib/ai.js` | Config validation, model listing |
| `server.js` | `lib/rag.js` | Legacy document Q&A |
| `server.js` | `lib/feedback.js` | Legacy text analysis |
| `story.js` | `lib/ai.js` | All AI inference calls |
| `story.js` | `story-rag.js` | Character/lore context retrieval |
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
| `tests/story-rag.test.js` | Per-story knowledge store operations |
| `tests/story-coherence.test.js` | Story coherence validation |
| `tests/server.test.js` | API endpoint integration tests |

**Design principles:**
- No real AI calls in tests — all dependencies are mocked
- Fake timers used for timeout testing
- Each test cleans up its filesystem artifacts

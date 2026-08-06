# PincerX

A local creative storytelling system. Give it a title, genre, and tone, and it generates an outline, creates a cast of characters, and writes chapters. Each story maintains a living knowledge store of characters and lore. You can read the narrative or hear it performed with distinct character voices via Zonos TTS.

## Quick Start

### 1. Start Ollama

PincerX needs an AI backend. The easiest option is [Ollama](https://ollama.com/):

```bash
# Install and start Ollama
curl -fsSL https://ollama.com/install.sh | sh
ollama serve

# Pull a model
ollama pull llama3
```

Or use OpenAI-compatible APIs (Groq, OpenRouter) via the web UI config panel.

### 2. Start PincerX

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser.

### 3. (Optional) Start Zonos TTS

For multi-voice narration, run the Zonos sidecar:

```bash
cd zonos
docker compose -f docker-compose.zonos.yml up
```

## Features

- **Story creation** — Generate outlines, characters, and locations from a title/genre/tone
- **Chapter generation** — Write chapters with character dialogue and emotion tags
- **Character management** — Track profiles, roles, and auto-assign voice presets
- **Lore system** — Maintain world details, locations, and plot elements
- **Multi-voice TTS** — Hear stories performed with distinct character voices
- **Voice transcript editor** — Fine-tune speaker and emotion for each paragraph

## Project Structure

```
├── api/server.js      # Express HTTP API
├── lib/                # Core modules (AI transport, RAG, feedback)
├── story/              # Story engine (creation, chapters, characters)
├── zonos/              # TTS sidecar (Python)
├── public/index.html   # Web UI
└── data/stories/       # Persisted story files
```

## Configuration

Configure your AI backend via the web UI (⚙ Settings) or by setting environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_BASE_URL` | `http://localhost:11434` | AI backend URL |
| `AI_MODEL` | `llama3` | Model name |
| `AI_API_KEY` | (none) | API key for cloud providers |
| `AI_PROVIDER` | `ollama` | Provider: ollama, openai, groq, openrouter |
| `PORT` | `3000` | HTTP server port |

## Development

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:report
```

## License

MIT

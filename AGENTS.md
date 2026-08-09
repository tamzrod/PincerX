# PincerX — Agent Notes

## Stack
- Express.js server (`api/server.js`) serving static `public/index.html` (~5000 lines, inline JS).
- AI via `lib/ai.js` (Ollama / OpenAI-compatible). Default base URL: `http://host.docker.internal:11434` (Docker-host-aware).
- Zonos TTS for multi-voice audio.

## Key conventions
- Frontend is a single `index.html` with two inline `<script>` blocks. Validate syntax with:
  ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('public/index.html','utf8');[...h.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((s,i)=>{try{new Function(s[1]);console.log('ok',i)}catch(e){console.log('ERR',i,e.message)}})"
  ```
- `apiFetch(url, opts)` wraps `fetch` + `res.json()` and throws on `!res.ok` (error message from `data.error`).
- Global AI status bar (`#ai-status-bar`) surfaces generation phase + errors via `showAIStatus(text, type, detail, autoHideMs)`. `preflightAIConnection()` probes `/models` before long generation so unreachable backends fail fast instead of stalling on "Loading…".

## Running
- `npm test` — 320 tests (jest). `npm start` / `node api/server.js` on port 3000.

## Browser-tool caveat
The browser automation tool can get stuck on `about:blank` (no tabs) mid-session and aggressively caches inline JS. When it fails, verify via `curl` against the server + server logs instead of fighting the browser.

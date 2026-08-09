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
- Live AI Conversation preview (`#ai-convo`, collapsible bottom-right panel) shows streaming generation in real time. Backed by SSE streaming endpoints: `POST /story/create/stream` and `POST /story/:id/chapter/stream`. These emit `progress`/`token`/`done`/`error` SSE events. Frontend `streamAIRequest(url, body, handlers)` parses the SSE stream via `fetch` + `ReadableStream.getReader()` (not `EventSource`, which only supports GET). `lib/ai.js#askStream(prompt, options, onToken)` streams from the AI backend (Ollama NDJSON / OpenAI SSE) with a buffered-JSON fallback. `story.js` accepts `onToken`/`onPhase` in `aiOptions` and routes to `askStream` when `onToken` is present.
- Coherence-guided regeneration: when a coherence check finds warnings, the Coherence tab shows a regeneration section (`#coherence-regen`) with the recommendation, an optional "Custom instructions" textarea, and a "🔄 Regenerate Chapter" button. Clicking it calls `regenerateChapterFromCoherence()` which hits the chapter stream endpoint with a `regenerate: { evidence, recommendation, customInstruction }` body. `story.js#generateChapter` detects `aiOptions.regenerate` and builds a regeneration prompt (preserving events/continuity, addressing the evidence, following the recommendation, and applying the custom instruction as an *additional* constraint — never a replacement for the coherence fix). Only the affected chapter is replaced; the original is preserved on failure (disk write happens only after successful generation). Coherence is auto-re-checked on the regenerated chapter and the panel refreshes; controls stay available for further iteration.
- Outline custom prompt: `story.js#create(title, genre, tone, aiOptions, customPrompt)` appends an "Additional instructions" block to the outline prompt when `customPrompt` is non-empty (mirrors the chapter `customPrompt` pattern). The Story Details section has a `#story-custom-prompt` textarea under the Model dropdown; `generateStory()` forwards it as `body.customPrompt` (only when non-empty). Both `POST /story/create` and `POST /story/create/stream` accept and trim `customPrompt`.

## Running
- `npm test` — 409 tests (jest). `npm start` / `node api/server.js` on port 3000.

## Reader Experience (emotional trajectory) subsystem
- Author-intent config (`story/story-experience.js#validateConfig`/`DEFAULT_CONFIG`): Primary/Secondary ∈ {Curiosity,Tension,Emotion,Mystery,Wonder,Suspense,Triumph}, Intensity ∈ {Low,Moderate,High}, Pacing ∈ {Slow,Moderate,Fast}. Stored as a per-story `reader_experience` RAG doc via `storyRag.setExperienceConfig`/`getExperienceConfig`/`getExperienceState`/`saveExperienceState` (added to `VALID_TYPES` — do NOT create a second storage system).
- Pipeline (`story.js#generateChapter`): before generation, `experience.synthesizeObjective(id, chapterNumber, aiOptions)` produces a structured chapter objective (currentState/targetState/readerQuestions/knowledgeManagement reveal-withhold-foreshadow/emotionalTrajectory/readerShouldDiscover/readerShouldNotDiscover/characterObjective/endingState/nextChapterPull). `experience.buildChapterObjectiveBlock(objective)` injects a compact block into the chapter prompt (does NOT dump the whole internal state). After generation + coherence, `experience.analyzeChapter(...)` soft-runs and returns findings (`{passed, observed, issues, recommendation}`); result includes `experience` + `experienceObjective`. State evolves in RAG (`trajectory`, `readerQuestions`, `currentState`).
- Chapter 1 is special: acquisition framing (immediate engagement, story promise, Chapter 2 anticipation, "Why should a new listener continue listening?"). Later chapters optimise for retention. No fixed hook formula — the synthesis LLM decides.
- Regeneration (`aiOptions.regenerate.experience = { findings, objective }`): folds experience feedback + objective into the regen prompt as additional constraints (never replacing coherence). The regen path reuses the provided objective (no new synthesis call) and re-analyses the regenerated chapter.
- Model propagation: `aiOptions.model` is forwarded to synthesis + analysis calls (maxTokens/streaming hooks stripped). Never hardcodes/falls back to another model.
- Repetition detection (`experience.detectRepetition`) scans chapter summaries via `storyRag.listDocs(id,'summary')`; flags `protagonist_wins` etc. and feeds the evidence into the synthesis prompt.
- Soft-fail: synthesis/analysis failures never block the chapter from saving; previous Reader Experience state is preserved. An unreachable LLM is reported via `error` on the result (do NOT mock Ollama to reproduce it).
- API endpoints (`api/server.js`): `GET/POST /story/:id/experience/config`, `GET /story/:id/experience/state`, `POST /story/:id/experience/synthesize`, `POST /story/:id/experience/analyze`. The chapter + chapter/stream endpoints accept `regenerate.experience`.
- UI: 🎯 Reader Experience config section (4 dropdowns, collapsible) in Story Details + an Experience sub-tab showing findings (✓/⚠), recommendation, and the synthesised objective preview. `regenerateChapterFromCoherence` forwards stored findings/objective; after regen it re-analyses experience.
- Tests: `tests/story-experience.test.js`, `tests/story-experience-integration.test.js`, +reader_experience tests in `tests/story-rag.test.js`, +experience endpoint tests in `tests/server.test.js`. Mock `ai.ask`/`story-rag`; no live LLM required.

## Browser-tool caveat
The browser automation tool can get stuck on `about:blank` (no tabs) mid-session and aggressively caches inline JS. When it fails, verify via `curl` against the server + server logs instead of fighting the browser.

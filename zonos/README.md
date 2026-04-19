# Zonos TTS Sidecar

A FastAPI server that wraps [Zonos](https://github.com/Zyphra/Zonos) to provide
text-to-speech synthesis with optional voice cloning.

---

## Requirements

- Docker (with NVIDIA runtime for GPU acceleration, optional)
- The `voices/` directory is created automatically inside the container at
  `/app/voices`.  Speaker embeddings (`.pt` files) are stored there.

---

## Quick start

### 1. Build the image

```bash
docker build -t pincerx-zonos zonos/
```

### 2. Run the container

**CPU only (slower, but works without a GPU):**

```bash
docker run --rm -p 8000:8000 pincerx-zonos
```

**With NVIDIA GPU:**

```bash
docker run --rm --gpus all -p 8000:8000 pincerx-zonos
```

**Persist uploaded voice embeddings across restarts** by mounting a local
directory to `/app/voices`:

```bash
docker run --rm -p 8000:8000 \
  -v "$(pwd)/zonos/voices:/app/voices" \
  pincerx-zonos
```

The container exposes the API on port **8000**.

---

## API reference

### `GET /health`

Returns server status, device info, list of saved voices, and available emotion
presets.

```bash
curl http://localhost:8000/health
```

### `GET /voices`

Lists all saved speaker embeddings and available emotion presets.

```bash
curl http://localhost:8000/voices
```

### `POST /synthesize`

Synthesizes speech and returns a WAV audio file.

| Field | Type | Default | Description |
|---|---|---|---|
| `text` | string | *required* | The text to synthesise. |
| `language` | string | `"en-us"` | BCP-47 language tag. |
| `voice_id` | string\|null | `null` | ID of a saved speaker embedding. Omit for default voice. |
| `speaking_rate` | float | `15.0` | Tokens per second (5 – 30). |
| `pitch_std` | float | `45.0` | Pitch standard deviation (0 – 200). |
| `emotion_preset` | string | `"neutral"` | One of the presets listed below. |

**Available emotion presets:** `neutral`, `happy`, `sad`, `calm`, `energetic`, `angry`

**Synthesize without a custom voice (default speaker):**

```bash
curl -s -X POST http://localhost:8000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello! Zonos is working."}' \
  --output output.wav
```

**Synthesize with a saved voice:**

```bash
curl -s -X POST http://localhost:8000/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello!", "voice_id": "my_voice", "emotion_preset": "happy"}' \
  --output output.wav
```

### `POST /voices/upload?name=<id>`

Upload an audio file (WAV, MP3, FLAC, OGG, or M4A) to create a speaker
embedding that can be referenced by `voice_id` in `/synthesize`.

A sample audio file is included in this repository at
`zonos/voices/sample/sample.wav` so you can try the workflow immediately.

```bash
curl -s -X POST "http://localhost:8000/voices/upload?name=my_voice" \
  -F "file=@zonos/voices/sample/sample.wav"
```

### `DELETE /voices/{voice_id}`

Removes a saved speaker embedding.

```bash
curl -s -X DELETE http://localhost:8000/voices/my_voice
```

---

## Voice ID rules

Voice IDs may only contain letters, digits, hyphens, and underscores
(`[A-Za-z0-9_-]`, 1–64 characters).

---

## Long text handling

Text longer than ~500 characters is automatically split on paragraph and
sentence boundaries.  Each chunk is synthesized separately and the resulting
audio segments are concatenated (with a short 0.4 s silence between
paragraphs).

---

## Notes

- The first startup downloads the `Zyphra/Zonos-v0.1-transformer` model
  weights from Hugging Face (~several GB).  Subsequent starts are fast.
- Without a GPU the model still works but synthesis is slower.
- See `example.sh` in this directory for a full `curl` walkthrough.

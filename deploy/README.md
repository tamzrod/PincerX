# PincerX – Docker Deployment Guide

This guide explains how to build and run PincerX using Docker in three modes.

---

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) ≥ 24
- [Docker Compose](https://docs.docker.com/compose/install/) v2 (bundled with Docker Desktop)

---

## Build the Image

From the repository root:

```bash
docker build -t pincerx .
```

To target a specific platform:

```bash
docker build --platform linux/amd64 -t pincerx .
# or
docker build --platform linux/arm64 -t pincerx .
```

---

## Environment Variables

| Variable      | Description                          | Example                          |
|---------------|--------------------------------------|----------------------------------|
| `AI_BASE_URL` | Base URL of the LLM API              | `http://host.docker.internal:11434` |
| `AI_MODEL`    | Model name to use                    | `llama3.2`, `gpt-4o`             |
| `AI_API_KEY`  | API key (leave empty for local Ollama) | `sk-...`                       |

Copy the example file and edit it before starting any compose stack:

```bash
cp deploy/.env.example deploy/.env
# then edit deploy/.env with your values
```

---

## Mode 1 – Local (host Ollama)

Runs only the PincerX container. Ollama must already be running on your host machine.

```bash
docker compose -f deploy/docker-compose.local.yml --env-file deploy/.env up -d
```

PincerX will reach Ollama via `http://host.docker.internal:11434`.

---

## Mode 2 – Full Stack (Ollama in Docker)

Starts both PincerX and an Ollama container.

```bash
docker compose -f deploy/docker-compose.stack.yml --env-file deploy/.env up -d
```

### Pull a model into the Ollama container

After the stack is running, pull the model you want to use:

```bash
docker compose -f deploy/docker-compose.stack.yml exec ollama ollama pull llama3.2
```

Replace `llama3.2` with any model supported by Ollama (e.g. `llama3.1`, `mistral`, `phi3`).

---

## Mode 3 – Cloud LLM

Use any OpenAI-compatible API by setting the environment variables in `deploy/.env`:

```
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4o
AI_API_KEY=sk-your-api-key-here
```

Then run either compose file (the local one is sufficient since no local Ollama is needed):

```bash
docker compose -f deploy/docker-compose.local.yml --env-file deploy/.env up -d
```

---

## Persistent Data

Both compose files mount the following host directories into the container:

| Host path | Container path | Purpose          |
|-----------|---------------|------------------|
| `./data`  | `/data`       | Processed data   |
| `./pdfs`  | `/pdfs`       | Uploaded PDFs    |

Data is preserved between container restarts because the directories live on the host.

---

## Stopping the Stack

```bash
# Local mode
docker compose -f deploy/docker-compose.local.yml down

# Stack mode
docker compose -f deploy/docker-compose.stack.yml down

# Stack + Zonos
docker compose -f deploy/docker-compose.stack.yml -f deploy/docker-compose.zonos.yml down
```

To also remove the Ollama model volume (stack mode only):

```bash
docker compose -f deploy/docker-compose.stack.yml down -v
```

---

## Zonos TTS (GPU text-to-speech)

PincerX includes a `🔊 Read` button on every story chapter. By default it uses
the browser's built-in Web Speech API. If you have an NVIDIA GPU you can run
the Zonos neural TTS sidecar for dramatically better voice quality.

### Requirements

- Docker with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) installed
- At least one NVIDIA GPU accessible to Docker

### Start the Zonos sidecar

Combine the Zonos overlay with the main stack compose file:

```bash
docker compose \
  -f deploy/docker-compose.stack.yml \
  -f deploy/docker-compose.zonos.yml \
  --env-file deploy/.env \
  up -d
```

The first run downloads the Zonos model weights (~5 GB) from Hugging Face and
caches them in the `zonos_cache` Docker volume.  Subsequent starts are fast.

### How it works

1. The `zonos` service runs a FastAPI server (`zonos/server.py`) on port 8000.
2. PincerX's Node backend exposes `POST /tts` which proxies text to `zonos/synthesize`.
3. The browser plays the returned WAV file directly via the Web Audio API.
4. If the Zonos sidecar is unreachable (e.g. not started), the `🔊 Read` button
   falls back transparently to the browser's Web Speech API.

### Environment variable

| Variable    | Description                        | Default                    |
|-------------|------------------------------------|----------------------------|
| `ZONOS_URL` | URL of the Zonos sidecar           | `http://localhost:8000`    |

Set `ZONOS_URL=http://zonos:8000` when running inside Docker Compose (the
overlay sets this automatically on the `pincerx` service).

### Running Zonos without Docker

If you prefer to run Zonos directly on the host (e.g. in a Python venv):

```bash
cd zonos
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

Then set `ZONOS_URL=http://host.docker.internal:8000` (or `http://localhost:8000`
if PincerX is also running directly on the host).

---

## Viewing Logs

```bash
docker compose -f deploy/docker-compose.local.yml logs -f pincerx
docker compose -f deploy/docker-compose.stack.yml logs -f
```

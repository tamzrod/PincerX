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
| `AI_MODEL`    | Model name to use                    | `llama3`, `gpt-4o`               |
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
docker compose -f deploy/docker-compose.stack.yml exec ollama ollama pull llama3
```

Replace `llama3` with any model supported by Ollama (e.g. `mistral`, `phi3`).

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
```

To also remove the Ollama model volume (stack mode only):

```bash
docker compose -f deploy/docker-compose.stack.yml down -v
```

---

## Viewing Logs

```bash
docker compose -f deploy/docker-compose.local.yml logs -f pincerx
docker compose -f deploy/docker-compose.stack.yml logs -f
```

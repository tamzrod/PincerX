#!/usr/bin/env bash
# example.sh – end-to-end Zonos TTS walkthrough using curl
#
# Prerequisites:
#   docker run --rm -p 8000:8000 \
#     -v "$(pwd)/zonos/voices:/app/voices" \
#     pincerx-zonos
#
# Then run this script from the repo root:
#   bash zonos/example.sh

set -euo pipefail

BASE_URL="${ZONOS_URL:-http://localhost:8000}"

echo "=== 1. Health check ==="
curl -s "${BASE_URL}/health" | python3 -m json.tool
echo

echo "=== 2. List voices (empty on first run) ==="
curl -s "${BASE_URL}/voices" | python3 -m json.tool
echo

echo "=== 3. Synthesize without a custom voice ==="
curl -s -X POST "${BASE_URL}/synthesize" \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello! Zonos text to speech is working."}' \
  --output /tmp/zonos_default.wav
echo "Saved: /tmp/zonos_default.wav"
echo

echo "=== 4. Upload the sample voice ==="
curl -s -X POST "${BASE_URL}/voices/upload?name=sample" \
  -F "file=@zonos/voices/sample/sample.wav" | python3 -m json.tool
echo

echo "=== 5. List voices (sample should appear) ==="
curl -s "${BASE_URL}/voices" | python3 -m json.tool
echo

echo "=== 6. Synthesize with the sample voice (happy preset) ==="
curl -s -X POST "${BASE_URL}/synthesize" \
  -H "Content-Type: application/json" \
  -d '{"text": "Great, voice cloning is working!", "voice_id": "sample", "emotion_preset": "happy"}' \
  --output /tmp/zonos_sample_happy.wav
echo "Saved: /tmp/zonos_sample_happy.wav"
echo

echo "=== 7. Delete the sample voice ==="
curl -s -X DELETE "${BASE_URL}/voices/sample" | python3 -m json.tool
echo

echo "=== Done ==="

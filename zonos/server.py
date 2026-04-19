"""
Zonos TTS sidecar server.

Exposes a single endpoint:
  POST /synthesize  {"text": "...", "language": "en-us"}
  → audio/wav

Long texts are split on paragraph / sentence boundaries so that each
Zonos generation call stays within a comfortable length.  The resulting
audio segments are concatenated (with a short silence between paragraphs)
before being returned as a single WAV file.
"""

import io
import re

import torch
import torchaudio
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from zonos.conditioning import make_cond_dict
from zonos.model import Zonos

app = FastAPI(title="Zonos TTS Server")

# ── Model initialisation ──────────────────────────────────────────────────────

_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
_MODEL_NAME = "Zyphra/Zonos-v0.1-transformer"

print(f"[Zonos] Loading {_MODEL_NAME} on {_DEVICE} …", flush=True)
_model = Zonos.from_pretrained(_MODEL_NAME, device=_DEVICE)
_model.eval()
_SAMPLING_RATE: int = _model.autoencoder.sampling_rate
print(f"[Zonos] Model ready (sampling_rate={_SAMPLING_RATE}).", flush=True)

# ── Text chunking ─────────────────────────────────────────────────────────────

_MAX_CHUNK_CHARS = 500  # max characters fed to Zonos per synthesis call


def _split_into_chunks(text: str) -> list[str]:
    """Split *text* into chunks that fit within *_MAX_CHUNK_CHARS*.

    Splits first on paragraph boundaries (double newlines), then on sentence
    boundaries (. ! ?) for any paragraph that is still too long.
    """
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", text) if p.strip()]
    chunks: list[str] = []
    for para in paragraphs:
        if len(para) <= _MAX_CHUNK_CHARS:
            chunks.append(para)
        else:
            # Split on sentence-ending punctuation followed by whitespace.
            sentences = re.split(r"(?<=[.!?])\s+", para)
            current = ""
            for sentence in sentences:
                if not current:
                    current = sentence
                elif len(current) + 1 + len(sentence) <= _MAX_CHUNK_CHARS:
                    current = current + " " + sentence
                else:
                    chunks.append(current)
                    current = sentence
            if current:
                chunks.append(current)
    return chunks or [text[:_MAX_CHUNK_CHARS]] if text.strip() else []


# ── Request / response schemas ────────────────────────────────────────────────


class SynthesizeRequest(BaseModel):
    text: str
    language: str = "en-us"


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "device": _DEVICE, "model": _MODEL_NAME}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")

    chunks = _split_into_chunks(text)
    all_wavs: list[torch.Tensor] = []

    with torch.inference_mode():
        for i, chunk in enumerate(chunks):
            cond_dict = make_cond_dict(
                text=chunk, language=req.language, device=_DEVICE
            )
            conditioning = _model.prepare_conditioning(cond_dict)
            codes = _model.generate(conditioning)
            # wavs shape: (batch, channels, samples) → take first item in batch
            wav = _model.autoencoder.decode(codes).cpu()[0]  # (channels, samples)
            all_wavs.append(wav)
            # Insert 0.4 s of silence between paragraphs (not after the last one)
            if i < len(chunks) - 1:
                channels = wav.shape[0]
                silence_frames = int(0.4 * _SAMPLING_RATE)
                all_wavs.append(torch.zeros(channels, silence_frames))

    # Concatenate along the samples dimension
    combined = torch.cat(all_wavs, dim=-1)  # (channels, total_samples)

    buf = io.BytesIO()
    torchaudio.save(buf, combined, _SAMPLING_RATE, format="wav")
    buf.seek(0)
    return Response(content=buf.read(), media_type="audio/wav")

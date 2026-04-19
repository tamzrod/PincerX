"""
Zonos TTS sidecar server.

Endpoints:
  POST /synthesize  {"text": "...", "language": "en-us", "voice_id": null,
                     "speaking_rate": 15.0, "pitch_std": 45.0,
                     "emotion_preset": "neutral"}
  → audio/wav

  GET  /voices                         → {"voices": [...]}
  POST /voices/upload?name=<id>        → multipart audio file → saved embedding
  DELETE /voices/{voice_id}            → removes saved embedding

Long texts are split on paragraph / sentence boundaries so that each
Zonos generation call stays within a comfortable length.  The resulting
audio segments are concatenated (with a short silence between paragraphs)
before being returned as a single WAV file.
"""

import io
import os
import pathlib
import re

import torch
import torchaudio
from fastapi import FastAPI, HTTPException, Path, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
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

# ── Voice embedding storage ───────────────────────────────────────────────────

_VOICES_DIR = pathlib.Path(os.getenv("VOICES_DIR", "/app/voices"))
_VOICES_DIR.mkdir(parents=True, exist_ok=True)

# Accepted audio file extensions for voice uploads
_AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".ogg", ".m4a"}

# Pattern for safe voice IDs (used in both path params and request bodies)
_VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# ── Emotion presets ───────────────────────────────────────────────────────────
# Each preset is a list of 8 floats corresponding to Zonos emotion dimensions:
# [happiness, sadness, disgust, fear, surprise, anger, other, neutral]

_EMOTION_PRESETS: dict[str, list[float]] = {
    "neutral":   [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0],
    "happy":     [0.7, 0.0, 0.0, 0.0, 0.1, 0.0, 0.0, 0.2],
    "sad":       [0.0, 0.7, 0.0, 0.0, 0.0, 0.0, 0.0, 0.3],
    "calm":      [0.1, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.9],
    "energetic": [0.5, 0.0, 0.0, 0.0, 0.3, 0.0, 0.0, 0.2],
    "angry":     [0.0, 0.0, 0.0, 0.0, 0.0, 0.8, 0.0, 0.2],
}

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
    # ID of a saved speaker embedding (filename stem stored in VOICES_DIR).
    # When null the model synthesises without a reference speaker, which still
    # sounds natural thanks to the rate/pitch defaults below.
    voice_id: str | None = None
    # Speaking rate in tokens/second; ~15 is normal conversational pace.
    speaking_rate: float = Field(default=15.0, ge=5.0, le=30.0)
    # Pitch standard deviation; higher = more expressive intonation.
    pitch_std: float = Field(default=45.0, ge=0.0, le=200.0)
    # One of the keys in _EMOTION_PRESETS.
    emotion_preset: str = "neutral"


# ── Helper: load a saved speaker embedding ────────────────────────────────────


def _load_speaker(voice_id: str) -> torch.Tensor | None:
    """Return the saved speaker embedding tensor for *voice_id*, or None.

    Validates that *voice_id* contains only safe characters and that the
    resolved path stays within *_VOICES_DIR* before loading, preventing both
    path-traversal and unsafe-deserialization issues.
    """
    if not _VOICE_ID_RE.match(voice_id):
        return None
    pt_path = (_VOICES_DIR / f"{voice_id}.pt").resolve()
    # Belt-and-suspenders: confirm the path is inside our voices directory.
    if not pt_path.is_relative_to(_VOICES_DIR.resolve()):
        return None
    if not pt_path.exists():
        return None
    # weights_only=True restricts loading to safe tensor data only.
    return torch.load(pt_path, map_location=_DEVICE, weights_only=True)


# ── Routes ────────────────────────────────────────────────────────────────────


@app.get("/health")
def health() -> dict:
    voices = [p.stem for p in _VOICES_DIR.glob("*.pt")]
    return {
        "status": "ok",
        "device": _DEVICE,
        "model": _MODEL_NAME,
        "voices": sorted(voices),
        "emotion_presets": list(_EMOTION_PRESETS.keys()),
    }


@app.get("/voices")
def list_voices() -> dict:
    voices = [p.stem for p in _VOICES_DIR.glob("*.pt")]
    return {"voices": sorted(voices), "emotion_presets": list(_EMOTION_PRESETS.keys())}


@app.post("/voices/upload")
async def upload_voice(
    name: str = Query(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
    file: UploadFile = ...,
) -> dict:
    """Accept an audio file and save a speaker embedding derived from it."""
    ext = pathlib.Path(file.filename or "").suffix.lower()
    if ext not in _AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Accepted: {', '.join(sorted(_AUDIO_EXTENSIONS))}",
        )

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty.")

    try:
        buf = io.BytesIO(audio_bytes)
        wav, sr = torchaudio.load(buf)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode audio: {exc}") from exc

    # Convert to mono and move to inference device
    wav_mono = wav.mean(0, keepdim=True).to(_DEVICE)

    try:
        with torch.inference_mode():
            speaker = _model.make_speaker_embedding(wav_mono, sr)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Failed to extract speaker embedding: {exc}",
        ) from exc

    torch.save(speaker.cpu(), _VOICES_DIR / f"{name}.pt")
    return {"message": f"Voice '{name}' saved.", "voice_id": name}


@app.delete("/voices/{voice_id}")
def delete_voice(
    voice_id: str = Path(..., min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
) -> dict:
    pt_path = (_VOICES_DIR / f"{voice_id}.pt").resolve()
    if not pt_path.is_relative_to(_VOICES_DIR.resolve()) or not pt_path.exists():
        raise HTTPException(status_code=404, detail=f"Voice '{voice_id}' not found.")
    pt_path.unlink()
    return {"message": f"Voice '{voice_id}' deleted."}


@app.post("/synthesize")
def synthesize(req: SynthesizeRequest) -> Response:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text must not be empty")

    # Resolve speaker embedding (None = no reference; still sounds natural with
    # explicit speaking_rate / pitch_std which cure the robotic default).
    speaker: torch.Tensor | None = None
    if req.voice_id:
        speaker = _load_speaker(req.voice_id)
        if speaker is None:
            raise HTTPException(status_code=404, detail=f"Voice '{req.voice_id}' not found.")

    emotion = _EMOTION_PRESETS.get(req.emotion_preset, _EMOTION_PRESETS["neutral"])

    chunks = _split_into_chunks(text)
    all_wavs: list[torch.Tensor] = []

    with torch.inference_mode():
        for i, chunk in enumerate(chunks):
            cond_dict = make_cond_dict(
                text=chunk,
                language=req.language,
                speaker=speaker,
                emotion=emotion,
                speaking_rate=req.speaking_rate,
                pitch_std=req.pitch_std,
                device=_DEVICE,
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

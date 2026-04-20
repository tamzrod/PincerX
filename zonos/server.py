"""
Zonos TTS sidecar server.

Endpoints:
  POST /synthesize  {"text": "...", "language": "en-us", "voice_id": null,
                     "speaking_rate": 15.0, "pitch_std": 45.0,
                     "emotion_preset": "neutral"}
  → audio/wav

  GET  /voices                         → {"voices": [...]}
  GET  /voices/presets                 → {"presets": [...]}
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
import threading

import torch
import torch._dynamo
import torchaudio

# torch.compile (dynamo) and FX symbolic tracing are mutually exclusive.
# Zonos applies torch.compile internally; disabling dynamo before model loading
# prevents the "FX tracing of a dynamo-optimized function" RuntimeError.
torch._dynamo.config.disable = True
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
# Ensure every sub-module (e.g. speaker encoder) is on the same device.
# from_pretrained moves most parameters but some lazy-initialised sub-modules
# can remain on CPU, causing a device-mismatch when make_speaker_embedding runs.
_model = _model.to(_DEVICE)
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

# ── Built-in voice presets ────────────────────────────────────────────────────
# Each preset is synthesised once at startup (using the default speaker with
# distinct prosody parameters) and its speaker embedding is saved to VOICES_DIR.
# The resulting .pt file is then used for subsequent synthesis requests just
# like any user-uploaded voice, providing differentiated voices for each
# character archetype without requiring audio samples from the user.

_VOICE_PRESETS: dict[str, dict] = {
    "preset-young-girl":     {
        "label":         "Young Girl (10–15 yrs)",
        "speaking_rate": 18.0,
        "pitch_std":     90.0,
        "phrase":        "Oh wow, that sounds so exciting! I can't wait to find out what happens!",
    },
    "preset-young-boy":      {
        "label":         "Young Boy (10–15 yrs)",
        "speaking_rate": 17.0,
        "pitch_std":     75.0,
        "phrase":        "Hey, check this out! That is really cool and I want to try it too!",
    },
    "preset-adult-female":   {
        "label":         "Adult Female (20–40 yrs)",
        "speaking_rate": 15.0,
        "pitch_std":     55.0,
        "phrase":        "Good morning. I hope this day finds you well and everything goes smoothly.",
    },
    "preset-adult-male":     {
        "label":         "Adult Male (20–40 yrs)",
        "speaking_rate": 14.0,
        "pitch_std":     35.0,
        "phrase":        "We need to talk about what happened yesterday and figure out a plan.",
    },
    "preset-elderly-female": {
        "label":         "Elderly Female",
        "speaking_rate": 11.0,
        "pitch_std":     40.0,
        "phrase":        "In my time, things were quite different, dear. Let me tell you about it.",
    },
    "preset-elderly-male":   {
        "label":         "Elderly Male",
        "speaking_rate": 10.0,
        "pitch_std":     25.0,
        "phrase":        "I have seen many things in my long life and learned much along the way.",
    },
}


def _ensure_prebuilt_voices() -> None:
    """Generate and save speaker embeddings for all built-in voice presets.

    For each preset whose .pt file does not yet exist, a short phrase is
    synthesised using the model's default speaker (no reference audio) but
    with the preset's distinctive prosody parameters.  The resulting audio is
    then fed back into the speaker encoder to extract an embedding that
    captures those prosodic characteristics.  The embedding is saved as
    ``<preset-id>.pt`` in VOICES_DIR so subsequent synthesis requests can
    reference it just like any user-uploaded voice.

    Errors for individual presets are logged as warnings and do not interrupt
    generation of the remaining presets.
    """
    for preset_id, spec in _VOICE_PRESETS.items():
        pt_path = _VOICES_DIR / f"{preset_id}.pt"
        if pt_path.exists():
            continue
        try:
            emotion = _EMOTION_PRESETS["neutral"]
            chunks  = _split_into_chunks(spec["phrase"])
            all_wavs: list[torch.Tensor] = []

            with torch.inference_mode():
                for chunk in chunks:
                    cond_dict = make_cond_dict(
                        text=chunk,
                        language="en-us",
                        speaker=None,
                        emotion=emotion,
                        speaking_rate=spec["speaking_rate"],
                        pitch_std=spec["pitch_std"],
                        device=_DEVICE,
                    )
                    conditioning = _model.prepare_conditioning(cond_dict)
                    # Preset phrases are at most ~6 s of speech; cap at 15 s to
                    # avoid allocating a full 30-second KV cache per preset.
                    # The oversized cache exhausts VRAM, causing a CUDA error
                    # that corrupts the device context and makes every subsequent
                    # synthesis request fail with "CUDA error: unknown error".
                    codes = _model.generate(
                        conditioning,
                        max_new_tokens=86 * 15,
                        progress_bar=False,
                    )
                    wav   = _model.autoencoder.decode(codes).cpu()[0]
                    all_wavs.append(wav)

            combined = torch.cat(all_wavs, dim=-1)

            with torch.inference_mode():
                # Re-apply device placement before calling make_speaker_embedding.
                # The speaker encoder contains sub-modules that initialise lazily
                # (i.e. on their first forward pass) and may default to CPU; ensuring
                # the whole model is on _DEVICE here moves those newly-created tensors
                # before the embedding is computed.
                _model.to(_DEVICE)
                speaker = _model.make_speaker_embedding(
                    combined.to(_DEVICE), _SAMPLING_RATE
                )

            torch.save(speaker.cpu(), pt_path)
            # Free any cached CUDA allocations before the next preset so that
            # repeated synthesis + speaker-encoder calls don't accumulate
            # fragmented VRAM across the six preset iterations.
            if _DEVICE != "cpu":
                torch.cuda.empty_cache()
            print(f"[Zonos] Generated preset voice: {preset_id}", flush=True)

        except Exception as exc:  # noqa: BLE001
            print(
                f"[Zonos] Warning: failed to generate preset '{preset_id}': {exc}",
                flush=True,
            )


# Launch preset generation in a background thread so the server starts
# immediately and presets become available once the thread finishes.
threading.Thread(
    target=_ensure_prebuilt_voices,
    daemon=True,
    name="prebuilt-voices",
).start()

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


@app.get("/voices/presets")
def list_voice_presets() -> dict:
    """Return the built-in voice presets with human-readable labels.

    The ``ready`` flag indicates whether the preset's speaker embedding (.pt
    file) has already been generated by the background startup thread.
    """
    presets = [
        {
            "id":    preset_id,
            "label": spec["label"],
            "ready": (_VOICES_DIR / f"{preset_id}.pt").exists(),
        }
        for preset_id, spec in _VOICE_PRESETS.items()
    ]
    return {"presets": presets}


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

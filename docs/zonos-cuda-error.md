# Issue Tracker: Zonos CUDA "unknown error" During Preset Generation

## Summary

A persistent CUDA error surfaces during startup when the Zonos sidecar tries to
generate built-in voice-preset embeddings.  The symptom is always the same log
line followed by a corrupted CUDA context that causes every subsequent synthesis
request to fail:

```
[Zonos] Warning: failed to generate preset 'preset-elderly-female': CUDA error: unknown error
CUDA kernel errors might be asynchronously reported at some other API call,
so the stacktrace below might be incorrect.
For debugging consider passing CUDA_LAUNCH_BLOCKING=1.
Compile with `TORCH_USE_CUDA_DSA` to enable device-side assertions.
```

---

## Root Cause (confirmed)

Zonos allocates a KV-cache sized to `max_new_tokens` tokens at the start of
each `generate()` call.  The default value (`86 × 30 = 2580` tokens, roughly
30 s of audio) exhausts VRAM when six preset phrases are synthesised back-to-
back during the background startup thread.  The OOM triggers an asynchronous
CUDA kernel error that is only reported on the *next* CUDA API call (often
inside a different preset), making the log line misleadingly point at the wrong
preset.  Once the CUDA context enters an error state it cannot be used again
without a full process restart.

The code comment in `zonos/server.py` at line 188–191 documents this directly:

```python
# Preset phrases are at most ~6 s of speech; cap at 15 s to
# avoid allocating a full 30-second KV cache per preset.
# The oversized cache exhausts VRAM, causing a CUDA error
# that corrupts the device context and makes every subsequent
# synthesis request fail with "CUDA error: unknown error".
codes = _model.generate(
    conditioning,
    max_new_tokens=86 * 15,   # ← was unbounded (default = 86 × 30)
    progress_bar=False,
)
```

---

## Fix Applied

**File:** `zonos/server.py` — `_ensure_prebuilt_voices()`

| Change | Before | After |
|--------|--------|-------|
| `max_new_tokens` in preset loop | default (2580 ≈ 30 s) | `86 * 15 = 1290` (≈ 15 s) |
| `torch.cuda.empty_cache()` after each preset | absent | called after every iteration |
| Speaker-encoder warm-up | absent | dummy tensor warm-up with `try/finally` + `_model.to(_DEVICE)` |

These three changes together prevent the VRAM exhaustion and ensure lazy
sub-modules are on the correct device before the preset loop starts.

---

## Conditions That Can Still Trigger the Error

Even with the fix in place the error may reappear under any of the following
conditions:

| Condition | What happens |
|-----------|-------------|
| GPU with < ~6 GB VRAM | VRAM is still exhausted even at 15 s; lower `max_new_tokens` further (e.g. `86 * 8`) |
| Container started without GPU access (`--gpus all` missing) | `_DEVICE` falls back to `"cpu"` silently; no CUDA error but synthesis is very slow |
| Multiple Zonos containers sharing one GPU | Competing VRAM allocations from other processes can trigger the same OOM path |
| Very long `phrase` in `_VOICE_PRESETS` | Chunking splits the phrase but each chunk still generates audio; more audio → more VRAM used in the encoder pass |
| Stale / partially-written `.pt` file in `VOICES_DIR` | `pt_path.exists()` returns `True` but `torch.load` raises; `_load_speaker` returns `None`, so synthesis falls back gracefully, but the preset is effectively missing |

---

## Diagnostic Steps

### 1 — Confirm the device being used

```bash
docker logs zonos-1 2>&1 | grep "\[Zonos\] Loading"
# Expected: [Zonos] Loading Zyphra/Zonos-v0.1-transformer on cuda …
# If "cpu" → container has no GPU access; add --gpus all / deploy.gpus config
```

### 2 — Enable synchronous CUDA error reporting

Add `CUDA_LAUNCH_BLOCKING=1` to the container's environment variables and
restart.  Errors will now be reported at the exact failing operation instead of
on the next unrelated call:

```yaml
# docker-compose.yml (zonos service)
environment:
  - CUDA_LAUNCH_BLOCKING=1
```

### 3 — Enable device-side assertions (deep debugging only)

Rebuild the PyTorch wheel with `TORCH_USE_CUDA_DSA=1`.  This is only required
if step 2 still does not pinpoint the failing kernel.  It is not needed for
normal operation.

### 4 — Check available VRAM

```bash
nvidia-smi
# Look at "Memory-Usage" for the GPU the container is using.
# 6 GB free is the practical minimum for the transformer model + preset generation.
```

### 5 — Inspect which presets succeeded

```bash
docker exec zonos-1 ls /app/voices/
# All six preset-*.pt files should be present after startup.
# Missing files = that preset failed; check logs for the exact error.
```

### 6 — Force preset regeneration

```bash
docker exec zonos-1 rm /app/voices/preset-*.pt
docker restart zonos-1
docker logs -f zonos-1 2>&1 | grep "\[Zonos\]"
```

---

## Workaround (if fix is not yet deployed)

Set `max_new_tokens` manually in the `_ensure_prebuilt_voices` call, or skip
preset generation entirely by pre-populating `VOICES_DIR` with `.pt` files
copied from a working container:

```bash
# On a working host, save all preset embeddings
docker cp zonos-1:/app/voices/ ./voices-backup/

# On the broken host, restore before starting the container
docker cp ./voices-backup/. zonos-1:/app/voices/
```

Because `_ensure_prebuilt_voices` skips any preset whose `.pt` file already
exists, the model will not attempt to regenerate them and the CUDA error will
not occur.

---

## Related Files

| File | Relevance |
|------|-----------|
| `zonos/server.py` | Zonos sidecar source; `_ensure_prebuilt_voices()` is the affected function |
| `zonos/Dockerfile` | Container image; `VOICES_DIR` env var default is `/app/voices` |
| `deploy/` | Docker Compose / deployment configuration; GPU resource allocation |

---

## History

| Date | Change | Author |
|------|--------|--------|
| 2026-04-20 | Root cause identified (VRAM exhaustion from oversized KV-cache); `max_new_tokens=86*15`, `empty_cache()`, and warm-up applied | Copilot |
| — | First observed in production logs (`preset-elderly-female` was the last preset generated, hence the last to fail) | — |

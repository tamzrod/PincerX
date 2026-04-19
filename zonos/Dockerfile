# syntax=docker/dockerfile:1

FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

WORKDIR /app

# System libraries needed by torchaudio / libsndfile / phonemizer.
# build-essential (g++) is required by torch.inductor for JIT kernel compilation.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libsndfile1 \
    espeak-ng \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

# Install Zonos from source, patching its pyproject.toml so that setuptools
# includes all subpackages (zonos.backbone, zonos.conditioning, …).
# The upstream uses include = ["zonos"] which only installs the top-level
# package; changing it to ["zonos*"] makes the glob match subpackages too.
RUN git clone --depth=1 https://github.com/Zyphra/Zonos.git /tmp/Zonos \
    && sed -i 's/include = \["zonos"\]/include = ["zonos*"]/' /tmp/Zonos/pyproject.toml \
    && pip install --no-cache-dir /tmp/Zonos \
    && rm -rf /tmp/Zonos

RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]

# Extension layer for the pinned OpenViking prototype image.
# Adds the `local-embed` extra (llama-cpp-python) so the offline, internal-network
# prototype runtime can embed without any remote provider. Does not modify any
# OpenViking source file; builds only on top of the reviewed base image.
FROM openviking-prototype:e44ea6e11add1c7b3d4accdbfaf16e900a6049df

ARG HTTP_PROXY=
ARG HTTPS_PROXY=

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake \
    && pip --python /app/.venv/bin/python install --no-cache-dir "llama-cpp-python>=0.3.0" \
    && apt-get purge -y build-essential cmake \
    && rm -rf /var/lib/apt/lists/*

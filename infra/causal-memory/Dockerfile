# Causal Memory runtime image for CoForge private deployments.
#
# Build context: the separately maintained causal-memory checkout, never this
# repository. The build caller must verify the source revision before invoking
# Docker; docs/operations/causal-memory-runtime.md records that procedure.
#
# W1-A replacement: after coforge/v1-extension is merged on top of
# 9657b2414ce7c56047d8273c9c0c8ebaf63985ee, pass its exact commit as
# CAUSAL_MEMORY_EXTENSION_REVISION and publish the resulting digest. Do not
# replace this base label with an unreviewed upstream main revision.
FROM rust:1.92-trixie AS builder

WORKDIR /build
COPY . .
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
RUN cargo build --locked --release --bin causal-memory

FROM debian:trixie-slim
ARG CAUSAL_MEMORY_REVIEWED_COMMIT=9657b2414ce7c56047d8273c9c0c8ebaf63985ee
ARG CAUSAL_MEMORY_EXTENSION_REVISION=unpatched
LABEL org.opencontainers.image.source="https://github.com/JingxuanC/causal-memory" \
      org.opencontainers.image.revision="$CAUSAL_MEMORY_EXTENSION_REVISION" \
      io.coforge.causal-memory.reviewed-commit="$CAUSAL_MEMORY_REVIEWED_COMMIT"

RUN apt-get update \
    && apt-get install --no-install-recommends --yes ca-certificates curl sqlite3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/causal-memory /usr/local/bin/causal-memory

# The W1-A extension reads the two *_FILE paths directly. The tenant map is
# also passed under the upstream-compatible CAUSAL_MEMORY_TOKENS_FILE name.
# Neither the image nor its command line contains credentials.
ENV CAUSAL_MEMORY_DB=/data/causal-memory.sqlite \
    CAUSAL_MEMORY_TOKENS_FILE=/run/secrets/coforge_causal_memory_tenant_tokens \
    CAUSAL_MEMORY_DISTILL_MODEL_API_KEY_FILE=/run/secrets/coforge_causal_memory_distill_model_api_key \
    CAUSAL_MEMORY_ALLOWED_HOSTS=causal-memory,localhost,127.0.0.1,::1

VOLUME ["/data"]
EXPOSE 9938
ENTRYPOINT ["causal-memory"]
CMD ["http", "--host", "0.0.0.0", "--port", "9938"]

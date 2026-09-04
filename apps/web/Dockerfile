FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/computer/package.json packages/computer/package.json
COPY packages/daemon/package.json packages/daemon/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN bun install --frozen-lockfile

COPY apps/web apps/web
COPY packages/agent packages/agent
COPY packages/protocol packages/protocol

# Generated outputs are gitignored but required for the build: buf-generated
# protobuf modules (packages/protocol/gen) and the prisma client
# (apps/web/generated).
RUN bun run --cwd packages/protocol generate \
  && bun run --cwd apps/web db:generate

RUN bun run --cwd apps/web build

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb AS migrate
WORKDIR /migrate
COPY scripts/deploy/prisma-migrate/package.json scripts/deploy/prisma-migrate/bun.lock ./
RUN bun install --frozen-lockfile --production
COPY apps/web/prisma prisma
COPY apps/web/prisma.config.ts prisma.config.ts

FROM oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb

WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

COPY --from=build --chown=bun:bun /app/apps/web/.output .output
COPY --from=migrate --chown=bun:bun /migrate .migrate

# Attachment bytes live on a mounted volume, not in the writable container layer.
# The directory has to exist and be owned by the runtime user in the image: Docker
# seeds a fresh named volume from the image path, so a volume mounted over a path
# that does not exist here would be created root-owned and unwritable.
RUN mkdir -p /data/attachments && chown -R bun:bun /data

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/health
CMD ["bun", ".output/server/index.mjs"]

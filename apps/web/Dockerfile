FROM oven/bun:1.4.0-alpine AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.base.json ./
COPY apps/coforge-computer/package.json apps/coforge-computer/package.json
COPY apps/coforge-daemon/package.json apps/coforge-daemon/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/cli/package.json packages/cli/package.json
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

FROM oven/bun:1.4.0-alpine

WORKDIR /app
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production

COPY --from=build --chown=bun:bun /app/apps/web/.output .output

USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.1:3000/health || exit 0
CMD ["bun", ".output/server/index.mjs"]

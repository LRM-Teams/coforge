FROM oven/bun:1.4.0-alpine

WORKDIR /app
COPY backend.ts ./backend.ts

USER bun
CMD ["bun", "run", "backend.ts"]

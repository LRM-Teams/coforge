# web

CoForge's Web UI and backend control plane. This package is a modular monolith
built with TanStack Start and Bun. Its UI foundation is Base UI with shadcn/ui,
Tailwind CSS v4, and Lucide icons.

The provisional theme follows the current CoForge UI specification: `#101319`
primary text and actions, `#5D36DC` brand states, `#E0E5F1` borders,
`#777D8D` muted text, and the documented notification, success, and offline
colors. Components consume semantic tokens so later design revisions do not
require component rewrites. Light and dark modes are both supported.

Internationalization follows TanStack Start's official Paraglide integration.
English and Simplified Chinese messages live under `messages`; locale-aware
URLs, SSR request handling, and `<html lang>` are generated through Paraglide.

```bash
mise install
mise run install
bun run --cwd apps/web dev
```

Edit `src/routes/index.tsx` to get started. Add route files under
`src/routes`; TanStack Router updates `src/routeTree.gen.ts` for you.

Run this package's short checks and production build with:

```bash
bun run --cwd apps/web test
bun run --cwd apps/web check
bun run --cwd apps/web build
```

Development runs directly on Bun/Vite with hot module replacement. Docker is
reserved for production builds and container verification. The production
server uses Nitro's Bun preset:

```bash
docker build -f apps/web/Dockerfile -t coforge-web .
docker run --rm -p 3000:3000 coforge-web
```

The pinned Nitro 3 adapter is currently beta and its production behavior must
remain covered by build, startup, health, and graceful-shutdown checks before a
release is promoted.

Add shadcn/ui components from the repository root:

```bash
bunx shadcn@latest add button --cwd apps/web
```

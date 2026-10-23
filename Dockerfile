# Enshrine VirtualOffice — production image (Next.js standalone).
# Use the Node.js 22.23.4 security release for every build stage.
FROM node:22.23.4-alpine AS base
# Version comes from package.json's `packageManager` field — one source of
# truth. `corepack prepare pnpm@9` pinned the MAJOR only, so the image's pnpm
# resolved latest-9.x at build time and floated between builds and against CI.
RUN corepack enable
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- build ---
FROM base AS builder
# Build-time placeholders so eager module init (Prisma client, env/crypto
# validation) never trips during `next build`. Real values are injected at
# runtime via .env; authed pages are force-dynamic so nothing DB-hits at build.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"
ENV AUTH_SECRET="build-time-placeholder-not-used-at-runtime"
ENV PII_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm build

# --- migrator (lightweight: `prisma migrate deploy` only) ---
# Just deps + the prisma schema/migrations — no `next build`, so it rebuilds
# fast (deps layer is cached; only the COPY prisma layer changes when a
# migration is added). Used by the compose `migrate` service so CI can apply
# pending migrations on every deploy. DATABASE_URL comes from .env at runtime.
FROM base AS migrator
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml ./
# Materialise pnpm INTO this layer. This stage has no build-time pnpm call —
# only its CMD — so without this the first invocation is the CMD, fetching
# pnpm from the npm registry at container start, on the droplet, during
# every deploy's migrate step.
# COREPACK_HOME is set OUTSIDE root's home and the store is made world-readable,
# so pnpm stays reachable whichever user this stage runs as. Without it,
# `corepack install` lands in $HOME/.cache = /root/.cache and works only by
# accident of this stage having no USER directive: add one and corepack silently
# goes back to fetching pnpm from the npm registry at container start, on the
# droplet, during every deploy's migrate. Asserted unconditionally by
# lib/dockerfile-corepack.test.ts so the check has teeth on every run.
ENV COREPACK_HOME=/opt/corepack
RUN corepack install && chmod -R a+rX /opt/corepack
COPY prisma ./prisma
# prisma/seed.ts imports from lib/ (crypto, seed-guard), so WITHOUT this the seed
# cannot run in this image — and `prisma migrate reset` drops the database, re-runs
# the migrations, then FAILS at the seed step, leaving an empty database with no
# accounts. Discovered 3 Oct 2026: `migrate reset` had never been usable in
# production for exactly this reason, and nothing surfaced it because `migrate
# deploy` (the only command this stage ran) needs no application code.
# Asserted by lib/dockerfile-migrator-seed.test.ts, which derives the required
# directories from prisma/seed.ts's own imports rather than hardcoding them.
COPY lib ./lib
COPY tsconfig.json ./
CMD ["pnpm", "prisma", "migrate", "deploy"]

# --- tools (one-off admin scripts: backfill dry runs / applies) ---
# Built and pushed by CI as virtualoffice-tools:<git sha>, and run on 165 only via
# deploy/vo-run-tool.sh — never built on the shared box. Contains the scripts and
# the lib/server/prisma sources they import, tsx and a generated Prisma client:
# no Next build, no .env (.dockerignore), and NO secrets or placeholder secrets in
# ENV. Every value a script needs is passed at run time, one allow-listed variable
# at a time, by the wrapper.
FROM base AS tools
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY prisma ./prisma
RUN pnpm prisma generate
COPY lib ./lib
COPY server ./server
COPY scripts ./scripts
RUN addgroup -S tools && adduser -S -G tools tools
USER tools
ENTRYPOINT ["node_modules/.bin/tsx"]

# --- runtime (standalone) ---
FROM base AS runner
# F7: the commit this image was built from, so a running container can be compared
# with `main`. Declared in THIS stage only — an ARG in an earlier stage would not
# reach the runtime env, and a global ARG would invalidate every stage's cache on
# every commit. Defaults to "unknown" so a local `docker build` without the arg
# still starts; CI always passes it.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=$BUILD_SHA
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001
# Uploads root — chown so a fresh named volume mounted here inherits nextjs
# ownership (the container runs as the non-root nextjs user).
RUN mkdir -p /data/uploads && chown -R nextjs:nodejs /data
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
# Liveness probe against the app's own /api/health (no DB — see that route).
# Uses node's built-in fetch so the runtime image needs no curl/wget. The
# start-period covers Next's boot; 3 failed 30s checks (~90s) mark it unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]

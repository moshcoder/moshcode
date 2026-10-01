# app.moshcode.sh on dev2: the web app lives in apps/pwa with its own dependencies
# (Railway built it with rootDirectory=apps/pwa; from the repo root nixpacks installs
# only the CLI's). The repo root is copied so relative imports keep resolving.
#
# Runs on Bun. The CLI in this repo is a Node/pnpm product and the PWA keeps its
# package-lock, so dependencies are still installed by `npm ci` exactly as before;
# only the runtime changes: Debian 12 (node:22-slim's base) with Bun's single
# binary and no node. Contract with dev2 unchanged: listens on $PORT (3000), answers
# /healthz, reads its secrets from app.env at run time.
FROM node:22-slim AS deps
WORKDIR /app
COPY . .
RUN cd apps/pwa && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.4.0-slim /usr/local/bin/bun /usr/local/bin/bun
# The non-root runtime user, uid 1000 like the oven/bun images.
RUN groupadd --gid 1000 bun && useradd --uid 1000 --gid bun --create-home --shell /bin/sh bun
WORKDIR /app
# --chown: dev2's checkout is group-only (660/2770) and COPY keeps those modes.
COPY --from=deps --chown=bun:bun /app /app
USER bun
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["bun", "apps/pwa/src/server.mjs"]

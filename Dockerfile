# app.moshcode.sh on dev2: the web app lives in apps/pwa with its own dependencies
# (Railway built it with rootDirectory=apps/pwa; from the repo root nixpacks installs
# only the CLI's). The repo root is copied so relative imports keep resolving.
FROM node:22-slim
WORKDIR /app
COPY . .
RUN cd apps/pwa && (npm ci --omit=dev 2>/dev/null || npm install --omit=dev)
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/pwa/src/server.mjs"]

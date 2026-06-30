# Voice Racer — single-process container for Azure Container Apps.
# The server runs TypeScript directly via tsx (the repo uses moduleResolution:Bundler with
# extensionless imports, so there's no clean tsc→node step); the client is a Vite build the server
# then serves statically. One process serves the client, the GLB assets, the API, and the
# game/voice WebSockets — required because room state is in-memory in this one process.
FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# ca-certificates for outbound HTTPS (Twilio REST, Draco/CDN), tini for clean signal handling.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

# Install ALL deps (incl. dev) — the client build needs vite + typescript, and the server runs via
# tsx, all of which live in devDependencies. NODE_ENV=production would skip them, so override here.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# App source (assets/ GLBs included so the server can serve them; see .dockerignore for exclusions).
COPY . .

# Build the client bundle (→ client/dist) that the server serves in production.
RUN npm run build

# start.sh links the persistent data dir (Azure Files mount) before launching the server.
RUN chmod +x scripts/start.sh

EXPOSE 8080

# tini reaps zombies + forwards SIGTERM so ACA can stop the container cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["scripts/start.sh"]

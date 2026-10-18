# syntax=docker/dockerfile:1

# Node 24 ships node:sqlite unflagged, which is why there is no build-essential
# stage here and no native module to compile.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Optional dependencies stay in: Tailwind's lightningcss and oxide, and Next's
# SWC compiler, ship their native binaries as optional platform packages, and
# the build fails without them. Electron's own binary is the one download the
# image never needs.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm prune --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app

# SWITCHBOARD_HOST=0.0.0.0 because inside a container the published port
# arrives on the container's own interface, not on loopback. What reaches it is
# decided by `docker run -p`; publish on 127.0.0.1 unless you mean otherwise.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=7272 \
    SWITCHBOARD_HOST=0.0.0.0 \
    SWITCHBOARD_DATA_DIR=/data

COPY --from=build /app/node_modules   ./node_modules
COPY --from=build /app/.next          ./.next
COPY --from=build /app/package.json   ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/server.mjs     ./server.mjs
COPY --from=build /app/bin            ./bin

# The data directory holds the database and the master key, so it must be
# writable by the unprivileged user and should be mounted as a volume.
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 7272

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7272/api/system/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]

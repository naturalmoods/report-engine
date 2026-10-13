# syntax=docker/dockerfile:1
ARG TARGETARCH

# Production dependencies. better-sqlite3 13.x ships prebuilt
# binaries in its npm package (linux-x64, linux-arm64), so no compiler toolchain is needed. Because of the package's
# binding.gyp, npm ci would run node-gyp rebuild by default: --ignore-scripts turns that off.
# If a platform has no prebuild, the first require fails (the build stage would need python3/make/g++).
FROM node:24.21.0-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Supercronic v0.2.49, checksum from the GitHub release (asset digest).
FROM scratch AS supercronic-amd64
ADD --checksum=sha256:a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1 --chmod=755 \
  https://github.com/aptible/supercronic/releases/download/v0.2.49/supercronic-linux-amd64 /supercronic
FROM scratch AS supercronic-arm64
ADD --checksum=sha256:02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5 --chmod=755 \
  https://github.com/aptible/supercronic/releases/download/v0.2.49/supercronic-linux-arm64 /supercronic
FROM supercronic-${TARGETARCH} AS supercronic

FROM node:24.21.0-slim
ENV TZ=Europe/Budapest \
    NODE_ENV=production \
    DATABASE_PATH=/data/report-engine.db \
    OUT_DIR=/data/out
WORKDIR /app
COPY --from=supercronic /supercronic /usr/local/bin/supercronic
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY deploy/crontab ./deploy/crontab
COPY src ./src
# The client config (config/) is not in the image: it is mounted at runtime (.dockerignore).
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
HEALTHCHECK --interval=5m --timeout=30s --start-period=30s \
  CMD ["node", "src/cli/index.ts", "status", "--health"]
CMD ["supercronic", "/app/deploy/crontab"]

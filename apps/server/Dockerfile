# ---- build frontend ----
# Build stages run on the BUILD machine's arch (their dist/ output is
# arch-independent JS) — without this, multi-arch CI builds crawl through
# vite/tsc under QEMU emulation for hours. Only the runtime stage is per-arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS webbuild
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace apps/web --include-workspace-root=false
COPY apps/web apps/web
RUN npm run build -w apps/web

# ---- build server (TS -> JS, so the container boots in seconds, not minutes) ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS serverbuild
WORKDIR /build
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --workspace apps/server --include-workspace-root=false
COPY apps/server apps/server
RUN npm run build -w apps/server

# ---- runtime ----
FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /srv
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
RUN npm ci --workspace apps/server --include-workspace-root=false --omit=dev
COPY apps/server apps/server
COPY --from=serverbuild /build/apps/server/dist apps/server/dist
COPY plugins plugins
COPY templates templates
COPY --from=webbuild /build/apps/web/dist apps/web/dist

ENV PORT=3000 \
    DATA_DIR=/data \
    META_DIR=/secrets \
    COMPILER_URL=http://compiler:4020 \
    PLUGINS_DIR=/srv/plugins \
    TEMPLATES_DIR=/srv/templates \
    WEB_DIST=/srv/apps/web/dist

EXPOSE 3000
WORKDIR /srv/apps/server
CMD ["node", "dist/index.js"]

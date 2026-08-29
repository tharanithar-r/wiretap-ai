# syntax=docker/dockerfile:1

# ---- Stage 1: build the React dashboard ----
FROM node:20-slim AS dashboard-build
WORKDIR /app/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN npm ci
COPY dashboard/ ./
RUN npm run build

# ---- Stage 2: build the API (better-sqlite3 needs python + build tools) ----
FROM node:20-slim AS api-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app/api
COPY api/package.json api/package-lock.json* ./
RUN npm ci
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build

# ---- Stage 3: runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
ENV ASSETS_DIR=/app/assets
ENV DASHBOARD_DIST=/app/dashboard/dist

# API runtime deps (fresh install, no build tools needed — better-sqlite3 prebuilt binary)
COPY --from=api-build /app/api/package.json /app/api/package-lock.json ./api/
WORKDIR /app/api
RUN npm ci --omit=dev
COPY --from=api-build /app/api/dist ./dist

WORKDIR /app
COPY --from=dashboard-build /app/dashboard/dist ./dashboard/dist
COPY assets ./assets

# persistent volumes: /app/api/data (SQLite) + /app/api/auth_info_baileys (WhatsApp session)
WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1
# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies (layer-cached unless lock file changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build the Vite frontend
COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Only ship the compiled frontend + the standalone server (no node_modules needed)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/railway-server.mjs ./railway-server.mjs

ENV PORT=3000
EXPOSE 3000

CMD ["node", "railway-server.mjs"]

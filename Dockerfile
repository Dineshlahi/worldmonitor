# syntax=docker/dockerfile:1
# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/railway-server.mjs ./railway-server.mjs

# Do NOT set ENV PORT — Railway injects $PORT automatically.
# Do NOT hardcode EXPOSE — Railway reads $PORT for routing.

CMD ["node", "railway-server.mjs"]

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

# Railway injects PORT=8080 at runtime — match it with EXPOSE so Railway
# knows where to route external traffic.
EXPOSE 8080

CMD ["node", "railway-server.mjs"]

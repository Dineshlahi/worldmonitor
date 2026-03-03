# syntax=docker/dockerfile:1
# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install dependencies first (layer-cached unless lock file changes)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

# Copy only what the runtime server needs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/api ./api
COPY --from=builder /app/server-railway.mjs ./server-railway.mjs
COPY package.json ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server-railway.mjs"]

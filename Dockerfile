FROM node:20-slim AS builder

WORKDIR /app

# Copy all package files for workspace resolution
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/relay-server/package.json packages/relay-server/
# Need stubs for other workspaces so npm ci doesn't fail
RUN mkdir -p packages/worker-daemon packages/master-mcp
COPY packages/worker-daemon/package.json packages/worker-daemon/
COPY packages/master-mcp/package.json packages/master-mcp/

# Install all deps
RUN npm ci

# Copy source for the packages we need
COPY packages/shared/ packages/shared/
COPY packages/relay-server/ packages/relay-server/

# Build
RUN npm run build --workspace=packages/shared && \
    npm run build --workspace=packages/relay-server

# --- Production stage ---
FROM node:20-slim AS production

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/relay-server/package.json packages/relay-server/
RUN mkdir -p packages/worker-daemon packages/master-mcp
COPY packages/worker-daemon/package.json packages/worker-daemon/
COPY packages/master-mcp/package.json packages/master-mcp/

RUN npm ci --omit=dev

# Copy built output
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/relay-server/dist packages/relay-server/dist

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "packages/relay-server/dist/index.js"]

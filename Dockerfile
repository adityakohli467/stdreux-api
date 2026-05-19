# ---------------- base ---------------- 
FROM node:18-alpine AS base
WORKDIR /app

# ---------------- deps ----------------
FROM base AS deps

# Required for native dependencies on Alpine
RUN apk add --no-cache libc6-compat

COPY package.json ./
RUN npm install

# ---------------- builder ----------------
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build NestJS (TypeScript -> dist/)
RUN npm run build

# ---------------- runner ----------------
FROM node:18-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8000

# Create non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nestjs

# Copy only what is required to run the app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules

# Create uploads directory with correct ownership
RUN mkdir -p /app/uploads && chown -R nestjs:nodejs /app/uploads

USER nestjs

EXPOSE 8000

CMD ["node", "dist/main.js"]

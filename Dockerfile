# syntax=docker/dockerfile:1

FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY api ./api
COPY openclaw ./openclaw
COPY public ./public
COPY story ./story
COPY ingest.js ./

RUN mkdir -p /data /pdfs

EXPOSE 3000

CMD ["node", "api/server.js"]

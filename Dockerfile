FROM node:22-bookworm-slim

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps

# App source + PDF + ingest progress (needed for /api/health + /api/manual)
COPY config.js server.js chunkText.js layoutArticles.js ingest.js ingest-lexical.js ingestExam.js query.js ./
COPY services ./services
COPY middleware ./middleware
COPY models ./models
COPY routes ./routes
COPY data ./data
COPY cache ./cache

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Bind all interfaces (Express default); CHROMA_URL comes from K8s
CMD ["node", "server.js"]

# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY index.html tsconfig.json vite.config.ts ./
COPY src/ ./src/
COPY public/ ./public/
COPY firebase-applet-config.json firebase-blueprint.json ./
# Empty env vars for build — runtime keys injected via Cloud Run env vars
ENV GEMINI_API_KEY=""
ENV GOOGLE_MAPS_PLATFORM_KEY=""
RUN npx vite build

# Stage 2: Backend dependencies
FROM node:20-slim AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/ ./

# Stage 3: Production
FROM node:20-slim
WORKDIR /app

# Copy backend with deps
COPY --from=backend-build /app/backend ./backend
# Copy frontend build output
COPY --from=frontend-build /app/dist ./frontend-dist
# Copy data files (MUTCD vector DB, extracted TA data)
COPY data/mutcd_2026_vector_db.json ./data/
COPY data/mutcd_part6_extracted.json ./data/

# Install tsx for TypeScript execution
RUN npm install -g tsx

# Create tmp dir for ephemeral PDF artifacts
RUN mkdir -p /app/tmp

WORKDIR /app/backend

# Cloud Run injects PORT
ENV PORT=8080
EXPOSE 8080

CMD ["tsx", "server.ts"]

# Medusa backend for Railway. Build context: Medusa_Store/medusa (the monorepo root).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NODE_ENV=development
COPY package.json package-lock.json turbo.json ./
COPY apps/backend/package.json apps/backend/package.json
RUN npm ci --workspace @dtc/backend --include-workspace-root
COPY apps/backend apps/backend
RUN npm run build --workspace @dtc/backend

FROM node:22-bookworm-slim AS runtime
WORKDIR /app/apps/backend/.medusa/server
ENV NODE_ENV=production
COPY --from=build /app/apps/backend/.medusa/server ./
RUN npm ci --omit=dev
EXPOSE 9000
# Migrations run on every deploy before the server starts; they are idempotent.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]

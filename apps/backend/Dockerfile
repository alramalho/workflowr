FROM node:22-slim AS build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile --filter backend

COPY apps/backend apps/backend
RUN pnpm --filter backend build
RUN pnpm --filter backend deploy /app/deployed

FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/deployed/dist ./dist
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "dist/app.js"]

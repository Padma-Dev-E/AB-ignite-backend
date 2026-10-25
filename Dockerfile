ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
WORKDIR /app
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY types ./types
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY drizzle.config.ts ./
RUN npm run api:build

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/apps/api/src ./apps/api/src
COPY --from=build --chown=node:node /app/apps/api/package.json /app/apps/api/tsconfig.json ./apps/api/
COPY --from=build --chown=node:node /app/types ./types
COPY --from=build --chown=node:node /app/drizzle.config.ts /app/package.json /app/package-lock.json ./
COPY --chown=node:node docker ./docker
RUN mkdir -p /app/data && chown node:node /app/data && chmod 755 /app/docker/entrypoint.sh
USER node
EXPOSE 4100
ENTRYPOINT ["./docker/entrypoint.sh"]
